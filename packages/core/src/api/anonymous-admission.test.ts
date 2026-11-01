import { expect, it, vi } from 'vitest';
import { createAnonymousAdmission } from './anonymous-admission.js';

it('enforces independent endpoint, organization and IP budgets with a smaller missing-IP budget', () => {
  let now = 0;
  const admit = createAnonymousAdmission(() => now);
  for (const endpoint of ['login-start', 'login-poll', 'oidc-exchange'] as const) {
    const budget = endpoint === 'login-poll' ? 60 : 10;
    const unknownBudget = endpoint === 'login-poll' ? 60 : 2;
    for (let n = 0; n < unknownBudget; n++) expect(admit('org', endpoint, null)).toBe(0);
    expect(admit('org', endpoint, 'invalid')).toBe(60);
    expect(admit('other', endpoint, null)).toBe(0);
    for (let n = 0; n < budget; n++) expect(admit('org', endpoint, '192.0.2.1')).toBe(0);
    expect(admit('org', endpoint, '192.0.2.1')).toBe(60);
  }
  now = 1001;
  expect(admit('org', 'login-start', null)).toBe(59);
  now = 60_000;
  expect(admit('org', 'login-start', null)).toBe(0);
});

it('evicts the least recently used bucket, refreshing even refused touches', () => {
  const admit = createAnonymousAdmission(() => 0, 2);
  for (let n = 0; n < 10; n++) expect(admit('org', 'login-start', '192.0.2.1')).toBe(0);
  expect(admit('org', 'login-start', '192.0.2.2')).toBe(0);
  expect(admit('org', 'login-start', '192.0.2.1')).toBe(60);
  expect(admit('org', 'login-start', '192.0.2.3')).toBe(0);
  expect(admit('org', 'login-start', '192.0.2.1')).toBe(60);
  for (let n = 0; n < 10; n++) expect(admit('org', 'login-start', '192.0.2.2')).toBe(0);
  expect(admit('org', 'login-start', '192.0.2.2')).toBe(60);
});

it('admits fresh clients after a flood of distinct IPv6 /64s without scanning buckets at capacity', () => {
  const admit = createAnonymousAdmission(() => 0, 64);
  const keys = Map.prototype.keys;
  let steps = 0;
  const keySpy = vi.spyOn(Map.prototype, 'keys').mockImplementation(function (
    this: Map<unknown, unknown>,
  ) {
    const iterator = keys.call(this);
    const next = iterator.next.bind(iterator);
    iterator.next = () => {
      steps++;
      return next();
    };
    return iterator;
  });
  const entries = vi.spyOn(Map.prototype, 'entries');
  const values = vi.spyOn(Map.prototype, 'values');
  const iterator = vi.spyOn(Map.prototype, Symbol.iterator);
  const outcomes = [];
  let scans: number;
  try {
    for (let n = 0; n < 5000; n++)
      outcomes.push(admit('org', 'login-start', `2001:db8:${n.toString(16)}::1`));
    outcomes.push(admit('org', 'login-start', '2001:db9::1'));
    scans = entries.mock.calls.length + values.mock.calls.length + iterator.mock.calls.length;
  } finally {
    keySpy.mockRestore();
    entries.mockRestore();
    values.mockRestore();
    iterator.mockRestore();
  }
  expect(outcomes.every((outcome) => outcome === 0)).toBe(true);
  expect(steps).toBe((5001 * 2 - 64) * 2);
  expect(scans).toBe(0);
});

it('shares the budget across IPv6 spellings and addresses within one /64', () => {
  const admit = createAnonymousAdmission(() => 0);
  for (let n = 0; n < 10; n++) expect(admit('org', 'login-start', '2001:db8::1')).toBe(0);
  expect(admit('org', 'login-start', '2001:0DB8:0:0:ffff:ffff:ffff:ffff')).toBe(60);
  expect(admit('org', 'login-start', '2001:db8:0:1::1')).toBe(0);
  expect(admit('org', 'login-start', '2001:db8:1::1')).toBe(0);
});

it('shares IPv4-mapped socket addresses with their full IPv4 address', () => {
  const admit = createAnonymousAdmission(() => 0);
  for (let n = 0; n < 10; n++) expect(admit('org', 'login-start', '192.0.2.1')).toBe(0);
  expect(admit('org', 'login-start', '::ffff:192.0.2.1')).toBe(60);
  expect(admit('org', 'login-start', '192.0.2.2')).toBe(0);
});

it.each([
  ['login-start', 10],
  ['login-poll', 60],
  ['oidc-exchange', 10],
] as const)('allows 16 full /64 budgets within one /48 for %s', (endpoint, budget) => {
  const admit = createAnonymousAdmission(() => 0);
  for (let subnet = 0; subnet < 16; subnet++) {
    const ip = `2001:db8:1:${subnet.toString(16)}::1`;
    for (let n = 0; n < budget; n++) expect(admit('org', endpoint, ip)).toBe(0);
    expect(admit('org', endpoint, ip)).toBe(60);
  }
  for (let n = 0; n < budget; n++) expect(admit('org', endpoint, '2001:db8:1:10::1')).toBe(60);
  expect(admit('org', endpoint, '2001:db8:2::1')).toBe(0);
});

it('refuses cycling capacity plus one /64 keys within one /48', () => {
  const capacity = 8;
  const admit = createAnonymousAdmission(() => 0, capacity);
  for (let n = 0; n < 160; n++)
    expect(admit('org', 'login-start', `2001:db8:1:${(n % (capacity + 1)).toString(16)}::1`)).toBe(
      0,
    );
  for (let n = 160; n < 160 + (capacity + 1) * 3; n++)
    expect(admit('org', 'login-start', `2001:db8:1:${(n % (capacity + 1)).toString(16)}::1`)).toBe(
      60,
    );
});

it('evicts the oldest expired window before a live LRU bucket', () => {
  let now = 0;
  const admit = createAnonymousAdmission(() => now, 3);
  expect(admit('org', 'login-start', '192.0.2.1')).toBe(0);
  expect(admit('org', 'login-start', '192.0.2.2')).toBe(0);
  now = 30_000;
  for (let n = 0; n < 10; n++) expect(admit('org', 'login-start', '192.0.2.3')).toBe(0);
  // Touch the expired candidates after the live bucket, separating expiry order from LRU.
  expect(admit('org', 'login-start', '192.0.2.1')).toBe(0);
  expect(admit('org', 'login-start', '192.0.2.2')).toBe(0);
  now = 60_000;
  expect(admit('org', 'login-start', '192.0.2.4')).toBe(0);
  expect(admit('org', 'login-start', '192.0.2.3')).toBe(30);
});

it('pins the shared unknown bucket through LRU pressure and resets it after expiry', () => {
  let now = 0;
  const admit = createAnonymousAdmission(() => now, 2);
  expect(admit('org', 'login-start', null)).toBe(0);
  expect(admit('org', 'login-start', null)).toBe(0);
  for (let n = 1; n < 20; n++) expect(admit('org', 'login-start', `192.0.2.${n}`)).toBe(0);
  expect(admit('org', 'login-start', null)).toBe(60);
  now = 60_000;
  expect(admit('org', 'login-start', null)).toBe(0);
});

it('keeps pinned unknown buckets within capacity when organizations fill the table', () => {
  const admit = createAnonymousAdmission(() => 0, 1);
  expect(admit('org', 'login-start', null)).toBe(0);
  expect(admit('other', 'login-start', null)).toBe(60);
  expect(admit('org', 'login-start', null)).toBe(0);
  expect(admit('org', 'login-start', null)).toBe(60);
});

it('retains 65,536 live entries at the default capacity', () => {
  const admit = createAnonymousAdmission(() => 0);
  for (let n = 0; n < 10; n++) expect(admit('org', 'login-start', '192.0.2.1')).toBe(0);
  for (let n = 1; n < 65_536; n++)
    admit('org', 'login-start', `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
  expect(admit('org', 'login-start', '192.0.2.1')).toBe(60);
});
