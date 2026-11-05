import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import {
  createOidcRepository,
  findTrustedPublishersStatement,
  oidcReplayStatements,
  purgeOidcReplayStatement,
} from './oidc.js';
const ctx = orgContext('org');
const match = {
  packageName: 'test',
  repositoryId: '123',
  repositoryOwnerId: '456',
  workflow: 'publish.yml',
  environment: '',
};
const input = {
  issuer: 'https://token.actions.githubusercontent.com',
  jti: 'unique',
  trustedPublisherId: 'publisher',
  expectedRevision: 1,
  expiresAt: 1800000300,
  now: '2026-10-31T00:00:00.000Z',
};
describe('OIDC repository input bounds', () => {
  it.each([
    { packageName: '' },
    { packageName: 'x'.repeat(215) },
    { repositoryId: '1'.repeat(21) },
    { repositoryOwnerId: '1'.repeat(21) },
    { workflow: 'x'.repeat(256) },
    { environment: 'x'.repeat(256) },
    { environment: 'é'.repeat(128) },
    { workflow: 'bad\nvalue' },
  ])('bounds binding lookup values %j', (patch) => {
    expect(() => findTrustedPublishersStatement(ctx, { ...match, ...patch })).toThrow(
      'invalid_oidc_input',
    );
  });
  it.each([
    { issuer: 'https://other.test' },
    { jti: '' },
    { jti: 'x'.repeat(257) },
    { trustedPublisherId: 'x'.repeat(129) },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expiresAt: -1 },
    { expiresAt: 1.5 },
    { expiresAt: 253402297200 },
    { now: '2026-10-31' },
  ])('bounds replay reservation values %j', (patch) => {
    expect(() => oidcReplayStatements(ctx, { ...input, ...patch })).toThrow('invalid_oidc_input');
  });
  it.each(['bad date', '2026-10-31', '2026-13-31T00:00:00.000Z', '2026-02-31T00:00:00.000Z'])(
    'refuses malformed purge instants',
    (now) => {
      expect(() => purgeOidcReplayStatement(ctx, now)).toThrow('invalid_oidc_input');
    },
  );
});

it('refuses oversized database input before allocating its UTF-8 encoding', () => {
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    expect(() =>
      findTrustedPublishersStatement(ctx, { ...match, packageName: 'x'.repeat(215) }),
    ).toThrow('invalid_oidc_input');
    expect(encode).not.toHaveBeenCalled();
  } finally {
    encode.mockRestore();
  }
});

it('caps timestamp input before parsing it', () => {
  const parse = vi.spyOn(Date, 'parse');
  try {
    expect(() => purgeOidcReplayStatement(ctx, 'x'.repeat(25))).toThrow('invalid_oidc_input');
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

it('exposes replay as an opaque unit that appends the insert and assertion contiguously', () => {
  const repository = createOidcRepository({ driver: 'none', all: vi.fn(), batch: vi.fn() });
  const unit = repository.reserveStatements(ctx, input);
  expect(Object.keys(unit)).toEqual(['appendTo']);
  expect(Object.isFrozen(unit)).toBe(true);
  const prefix = [{ sql: 'SELECT 1', params: [] }];
  const batch = unit.appendTo(prefix);
  expect(batch).toEqual([...prefix, ...unit.appendTo([])]);
  expect(prefix).toHaveLength(1);
  expect(batch[1]?.sql).toMatch(/^insert into "oidc_replay"/);
  expect(batch[2]?.sql).toContain('changes() = 1');
});
