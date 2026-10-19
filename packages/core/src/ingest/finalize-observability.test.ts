import { expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import type { BlobStore } from '../platform/blob.js';
import type { Cache } from '../platform/cache.js';
import type { ObsRecord } from '../platform/observability.js';
import { requirePlatformPorts } from '../plugin.js';
import { assertFinalizeAllowed } from './finalize-guard.js';

it('delivers mass absence through the real kernel observability registry without dropping it', async () => {
  const records: ObsRecord[] = [];
  await createKernel({
    platform: 'node',
    plugins: [
      {
        id: 'ingest-test',
        package: '@test/ingest-test',
        apiVersion: 3,
        platforms: ['node'],
        register() {},
        init(ports) {
          expect(() =>
            assertFinalizeAllowed(
              1,
              {
                attemptedCandidates: 2,
                successfulCandidates: 1,
                definitiveAbsent: 1,
              },
              { observability: requirePlatformPorts(ports).observability },
            ),
          ).toThrow('sync stopped');
        },
      },
    ],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-19T00:00:00.000Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    platformServices: {
      blob: {} as BlobStore,
      cache: {} as Cache,
      jobStore: {
        enqueue: async () => {
          throw new Error('unexpected enqueue');
        },
        status: async () => null,
      },
    },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    observability: {
      deploymentId: 'dep-1',
      sink: {
        emit: (record) => {
          records.push(record);
        },
      },
    },
  });
  expect(records.filter((record) => record.kind === 'log')).toEqual([
    {
      kind: 'log',
      record: expect.objectContaining({
        level: 'warn',
        event: 'ingest.mass_absence',
        reason_code: 'mass_absence',
      }),
    },
  ]);
  expect(records).toContainEqual({
    kind: 'counter',
    name: 'pb.ingest.mass_absence',
    labels: {},
    value: 1,
  });
  expect(
    records.some((record) => record.kind === 'counter' && record.name === 'pb.obs.dropped'),
  ).toBe(false);
});

it('delivers ingest.version_skipped through the real kernel observability registry', async () => {
  const records: ObsRecord[] = [];
  await createKernel({
    platform: 'node',
    plugins: [
      {
        id: 'ingest-test',
        package: '@test/ingest-test',
        apiVersion: 3,
        platforms: ['node'],
        register() {},
        init(ports) {
          requirePlatformPorts(ports).observability.log({
            level: 'info',
            event: 'ingest.version_skipped',
            reason_code: 'member_too_large',
          });
        },
      },
    ],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-19T00:00:00.000Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    platformServices: {
      blob: {} as BlobStore,
      cache: {} as Cache,
      jobStore: {
        enqueue: async () => {
          throw new Error('unexpected enqueue');
        },
        status: async () => null,
      },
    },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    observability: {
      deploymentId: 'dep-1',
      sink: {
        emit: (record) => {
          records.push(record);
        },
      },
    },
  });
  expect(records.filter((record) => record.kind === 'log')).toEqual([
    {
      kind: 'log',
      record: expect.objectContaining({
        event: 'ingest.version_skipped',
        reason_code: 'member_too_large',
      }),
    },
  ]);
  expect(records).not.toContainEqual(
    expect.objectContaining({ name: 'pb.obs.dropped', labels: { signal: 'unregistered' } }),
  );
});

it('delivers ingest.snapshot_corrupt through the real kernel observability registry', async () => {
  const records: ObsRecord[] = [];
  await createKernel({
    platform: 'node',
    plugins: [
      {
        id: 'ingest-test',
        package: '@test/ingest-test',
        apiVersion: 3,
        platforms: ['node'],
        register() {},
        init(ports) {
          requirePlatformPorts(ports).observability.log({
            level: 'warn',
            event: 'ingest.snapshot_corrupt',
            reason_code: 'snapshot_corrupt',
          });
        },
      },
    ],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-19T00:00:00.000Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    platformServices: {
      blob: {} as BlobStore,
      cache: {} as Cache,
      jobStore: {
        enqueue: async () => {
          throw new Error('unexpected enqueue');
        },
        status: async () => null,
      },
    },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    observability: {
      deploymentId: 'dep-1',
      sink: {
        emit: (record) => {
          records.push(record);
        },
      },
    },
  });
  expect(records.filter((record) => record.kind === 'log')).toEqual([
    {
      kind: 'log',
      record: expect.objectContaining({
        event: 'ingest.snapshot_corrupt',
        reason_code: 'snapshot_corrupt',
      }),
    },
  ]);
  expect(records).not.toContainEqual(
    expect.objectContaining({ name: 'pb.obs.dropped', labels: { signal: 'unregistered' } }),
  );
});

it('registers ingest.budget_exhausted with its reason code', async () => {
  const { INGEST_EVENTS, INGEST_REASON_CODES } = await import('./finalize-guard.js');
  expect(INGEST_EVENTS.has('ingest.budget_exhausted')).toBe(true);
  expect(INGEST_REASON_CODES.has('budget_exhausted')).toBe(true);
});
