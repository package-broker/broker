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

export const entries: readonly MutationEntry[] = [
  {
    builder: 'idempotencyInsertStatement',
    file: 'repositories/idempotency.ts',
    cases: [insertOwn],
    predicates: [],
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
