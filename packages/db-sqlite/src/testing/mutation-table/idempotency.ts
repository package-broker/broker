import { expect } from 'vitest';
import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import {
  createIdempotencyRepository,
  idempotencyInsertStatement,
} from '../../repositories/idempotency.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const record: IdempotencyRecord = {
  principalKey: 'user:mutation',
  key: 'shared',
  route: 'POST /api/projects',
  requestHash: 'ab'.repeat(32),
  status: 201,
  responseJson: '{}',
  createdAt: '2026-10-17T00:00:00.000Z',
  expiresAt: '2026-10-18T00:00:00.000Z',
};
const NOW = '2026-10-19T00:00:00.000Z';

const insertOwn: ContractCase = {
  name: 'insert binds the supplied organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await context.executor.batch([context.mutate(idempotencyInsertStatement(own, record))]);
    const repo = createIdempotencyRepository(context.executor);
    expect(await repo.find(own, record.principalKey, record.key, record.createdAt)).toEqual(record);
    expect(await repo.find(foreign, record.principalKey, record.key, record.createdAt)).toBeNull();
  },
};

const scopedRepository: ContractCase = {
  name: 'find and bounded purge preserve foreign records with shared and distinct keys',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await context.executor.batch([
      idempotencyInsertStatement(own, record),
      idempotencyInsertStatement(foreign, record),
      idempotencyInsertStatement(foreign, {
        ...record,
        key: 'earliest-foreign',
        expiresAt: '2026-10-17T01:00:00.000Z',
      }),
    ]);
    const mutating: ScalarSqlExecutor = {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    };
    const repo = createIdempotencyRepository(mutating);
    expect(
      await repo.find(own, record.principalKey, 'earliest-foreign', record.createdAt),
    ).toBeNull();
    expect(await repo.purgeExpired(own, NOW, 1)).toBe(1);
    const reader = createIdempotencyRepository(context.executor);
    expect(await reader.find(own, record.principalKey, record.key, record.createdAt)).toBeNull();
    expect(await reader.find(foreign, record.principalKey, record.key, record.createdAt)).toEqual(
      record,
    );
    expect(
      await reader.find(foreign, record.principalKey, 'earliest-foreign', record.createdAt),
    ).not.toBeNull();
  },
};

const foreignLiveRowDoesNotBlock: ContractCase = {
  name: 'a live row of another organization neither blocks nor is taken over',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await context.executor.batch([idempotencyInsertStatement(foreign, record)]);
    const created = { ...record, createdAt: '2026-10-17T12:00:00.000Z' };
    await expect(
      context.executor.batch([context.mutate(idempotencyInsertStatement(own, created))]),
    ).resolves.toBeDefined();
    const reader = createIdempotencyRepository(context.executor);
    expect(await reader.find(own, record.principalKey, record.key, created.createdAt)).toEqual(
      created,
    );
    expect(await reader.find(foreign, record.principalKey, record.key, created.createdAt)).toEqual(
      record,
    );
  },
};

const expiredAtCreationReplaced: ContractCase = {
  name: 'a row expiring at the creation instant is replaced',
  async run(context) {
    const { own } = orgOf(context);
    await context.executor.batch([idempotencyInsertStatement(own, record)]);
    const replacement = {
      ...record,
      responseJson: '{"id":"replacement"}',
      createdAt: record.expiresAt,
      expiresAt: '2026-10-19T00:00:00.000Z',
    };
    await expect(
      context.executor.batch([context.mutate(idempotencyInsertStatement(own, replacement))]),
    ).resolves.toBeDefined();
    const reader = createIdempotencyRepository(context.executor);
    expect(await reader.find(own, record.principalKey, record.key, record.expiresAt)).toEqual(
      replacement,
    );
  },
};

const liveRowKept: ContractCase = {
  name: 'a live row is kept and the insert fails',
  async run(context) {
    const { own } = orgOf(context);
    await context.executor.batch([idempotencyInsertStatement(own, record)]);
    const attempt = context.executor.batch([
      context.mutate(
        idempotencyInsertStatement(own, {
          ...record,
          responseJson: '{"id":"replacement"}',
          createdAt: '2026-10-17T23:59:59.999Z',
          expiresAt: '2026-10-19T00:00:00.000Z',
        }),
      ),
    ]);
    await expect(attempt).rejects.toMatchObject({ kind: 'unique' });
    const reader = createIdempotencyRepository(context.executor);
    expect(await reader.find(own, record.principalKey, record.key, record.createdAt)).toEqual(
      record,
    );
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'idempotencyInsertStatement',
    file: 'repositories/idempotency.ts',
    cases: [insertOwn, foreignLiveRowDoesNotBlock, expiredAtCreationReplaced, liveRowKept],
    predicates: [
      {
        name: 'live row lookup organization',
        locate: /org_id = \?(?= AND principal_key = \? AND key = \? AND expires_at)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: foreignLiveRowDoesNotBlock.name,
      },
    ],
    sqlDecisions: [
      {
        name: 'a row expiring at the creation instant is not live',
        pattern: /expires_at > \?/,
        replacement: 'expires_at >= ?',
        expected: 1,
        case: expiredAtCreationReplaced,
      },
      {
        name: 'a row expiring at the creation instant is replaced',
        pattern: /<= excluded\.created_at/,
        replacement: '< excluded.created_at',
        expected: 1,
        case: expiredAtCreationReplaced,
      },
      {
        name: 'a row expiring after the creation instant is live',
        pattern: /expires_at > \?/,
        replacement: "expires_at > '9'",
        expected: 1,
        case: expiredAtCreationReplaced,
      },
    ],
  },
  {
    builder: 'createIdempotencyRepository',
    file: 'repositories/idempotency.ts',
    cases: [scopedRepository],
    predicates: [
      {
        name: 'lookup organization',
        locate: /org_id = \?(?= AND principal_key)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: scopedRepository.name,
      },
      {
        name: 'delete organization',
        locate: /org_id = \?(?= AND \(principal_key, key\))/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: scopedRepository.name,
      },
      {
        name: 'expiry selection organization',
        locate: /org_id = \?(?= AND expires_at)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: scopedRepository.name,
      },
    ],
  },
];
