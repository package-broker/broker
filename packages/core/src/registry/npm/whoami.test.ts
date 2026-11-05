import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../db/port.js';
import type { RequestContext } from '../../plugin.js';
import { createNpmHandleOf } from '../module.js';

const id = '01JABCDEFGHJKMNPQRSTVWXYZ12';
const org = orgContext('organization');
const context = (kind: 'user' | 'service' | 'customer' = 'user') =>
  ({ org, principal: { kind, id } }) as RequestContext;

function harness(name: string | null) {
  const users = { get: vi.fn(async () => ({ displayName: name })) };
  const services = { get: vi.fn(async () => ({ name })) };
  return { users, services, handleOf: createNpmHandleOf(users, services) };
}

describe('npm identity handles', () => {
  it.each(['user', 'service'] as const)(
    'reads the %s name in the request organization',
    async (kind) => {
      const { handleOf, users, services } = harness('build-bot');
      expect(await handleOf(context(kind))).toBe('build-bot');
      expect((kind === 'user' ? users : services).get).toHaveBeenCalledWith(org, id);
      expect((kind === 'user' ? services : users).get).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    '',
    'a@example.test',
    'two words',
    'tab\tname',
    'line\nname',
    '\u00a0',
    'control\u0000name',
    'zero\u200bwidth',
    'format\u2060name',
    'lone\ud800surrogate',
    'a'.repeat(215),
  ])('uses the full lowercase id for unsafe name %j', async (name) => {
    const { handleOf } = harness(name);
    for (const kind of ['user', 'service'] as const) {
      expect(await handleOf(context(kind))).toBe(`${kind}-${id.toLowerCase()}`);
    }
  });

  it.each(['user', 'service'] as const)('accepts a 214-character %s name', async (kind) => {
    expect(await harness('a'.repeat(214)).handleOf(context(kind))).toBe('a'.repeat(214));
  });

  it('refuses missing identities and unsupported principals', async () => {
    const get = vi.fn(async () => null);
    const handleOf = createNpmHandleOf({ get }, { get });
    expect(await handleOf(context())).toBeNull();
    expect(await handleOf(context('service'))).toBeNull();
    get.mockClear();
    expect(await handleOf(context('customer'))).toBeNull();
    expect(await handleOf({ ...context(), principal: null })).toBeNull();
    expect(await handleOf({ ...context(), org: null })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
