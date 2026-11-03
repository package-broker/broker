import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OrgContext } from './port.js';
import {
  NotificationRepositoryError,
  notificationDeliveryState,
  notificationEndpointState,
  notificationEventSelection,
  notificationMethod,
  type NotificationDeliveryQuery,
  type NotificationEndpointSummary,
  type NotificationReadRepository,
  type NotificationWriteRepository,
} from './notifications.js';

const refused = { name: 'NotificationRepositoryError', code: 'invalid_request' };

describe('notification port values', () => {
  it('returns a selection in canonical order', () => {
    expect(
      notificationEventSelection(['npm.package.dist_tag_changed', 'npm.package.published']),
    ).toEqual(['npm.package.published', 'npm.package.dist_tag_changed']);
  });

  it.each([
    ['an empty selection', []],
    ['no selection', undefined],
    ['an object', { 0: 'npm.package.published' }],
    ['an unknown event', ['npm.package.fetched']],
    ['a near miss', ['npm.package.Published']],
    ['a duplicate', ['npm.package.published', 'npm.package.published']],
    ['a non-string', [1]],
    [
      'more than five',
      [
        'npm.package.published',
        'npm.package.released',
        'npm.package.unpublished',
        'npm.package.deprecation_changed',
        'npm.package.dist_tag_changed',
        'npm.package.published',
      ],
    ],
  ])('refuses %s', (_label, value) => {
    expect(() => notificationEventSelection(value)).toThrow(
      expect.objectContaining(refused) as Error,
    );
  });

  it.each([
    [notificationEndpointState, ['enabled', 'disabled', 'deleted'], ['paused', 'Enabled', null]],
    [
      notificationDeliveryState,
      ['pending', 'sending', 'delivered', 'failed', 'cancelled'],
      ['queued', '', 0],
    ],
    [notificationMethod, ['POST', 'PUT'], ['GET', 'post', undefined]],
  ] as const)('accepts only the stored states', (parse, valid, invalid) => {
    for (const value of valid) expect(parse(value)).toBe(value);
    for (const value of invalid) expect(() => parse(value)).toThrow(NotificationRepositoryError);
  });

  it('uses a fixed message', () => {
    expect(new NotificationRepositoryError('endpoint_limit').message).toBe('endpoint_limit');
  });
});

describe('notification port types', () => {
  it('requires the owning project on every read and never exposes a deleted summary', () => {
    expectTypeOf<Parameters<NotificationReadRepository['listEndpoints']>>().toEqualTypeOf<
      [OrgContext, string, { readonly cursor?: string; readonly limit: number }]
    >();
    expectTypeOf<
      Parameters<NotificationReadRepository['getDelivery']>['length']
    >().toEqualTypeOf<4>();
    expectTypeOf<NotificationEndpointSummary['state']>().toEqualTypeOf<'enabled' | 'disabled'>();
    expectTypeOf<NotificationEndpointSummary>().not.toHaveProperty('url');
    expectTypeOf<NotificationEndpointSummary>().not.toHaveProperty('credentialId');
    expectTypeOf<NotificationEndpointSummary>().not.toHaveProperty('headers');
    const query: NotificationDeliveryQuery = { limit: 1 };
    // @ts-expect-error an unknown delivery state is not a filter
    const bad: NotificationDeliveryQuery = { limit: 1, state: 'queued' };
    expect([query, bad]).toHaveLength(2);
  });

  it('accepts only human session fences on writes', () => {
    type Fence = Parameters<NotificationWriteRepository['create']>[1];
    expectTypeOf<Fence>().toHaveProperty('sessionId');
    expectTypeOf<Fence>().not.toHaveProperty('job');
    expectTypeOf<Fence>().not.toHaveProperty('tokenId');
  });

  it('stays out of the public plugin and package entry points', () => {
    for (const entry of ['../plugin.ts', '../index.ts']) {
      expect(readFileSync(new URL(entry, import.meta.url), 'utf8'), entry).not.toMatch(
        /notification/i,
      );
    }
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(manifest.exports).filter((key) => /notification/i.test(key))).toEqual([]);
  });
});
