import type { MutationEntry } from './harness.js';
import { orgOf, seeder, type ContractCase } from './harness.js';
import { expect } from 'vitest';
import {
  revokeAllForUserStatement,
  sessionInsertStatement,
  revokePreviousStatement,
} from '../../repositories/session.js';
import {
  sessionOfForeignUser,
  seedUser,
  HASH,
  OTHER_HASH,
  FUTURE,
  ref,
  NOT_NULL,
} from './fixtures.js';

const revokeSparesForeignSessions: ContractCase = {
  name: 'revoking all sessions of a user leaves the sessions of another organization',
  async run(context) {
    const { own } = orgOf(context);
    await sessionOfForeignUser(context);
    await context.executor.batch([
      context.mutate(revokeAllForUserStatement(own, 'U-FOREIGN', '2030-01-01T00:00:00.000Z', [])),
    ]);
    const rows = await context.executor.all<{ revoked_at: string | null }>({
      sql: 'SELECT revoked_at FROM session WHERE id = ?',
      params: ['SES-FOREIGN'],
    });
    expect(rows[0]?.revoked_at).toBeNull();
  },
};

const sessionNotMintedForForeignUser: ContractCase = {
  name: 'a session is not minted for a user of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedUser(seed, 'U-FOREIGN', foreign.orgId);
    await context.executor.all(
      context.mutate(
        sessionInsertStatement(
          own,
          {
            id: 'SES-NEW',
            userId: 'U-FOREIGN',
            identityId: null,
            secretHash: HASH,
            csrfHash: OTHER_HASH,
            now: '2030-01-01T00:00:00.000Z',
            expiresAt: FUTURE,
            ip: null,
            userAgent: null,
          },
          [],
        ),
      ),
    );
    const rows = await context.executor.all<{ n: number }>({
      sql: 'SELECT count(*) AS n FROM session',
      params: [],
    });
    expect(rows[0]?.n).toBe(0);
  },
};

const hash = 'a'.repeat(64);
const stamp = '2026-01-01T00:00:00.000Z';
const rotationCases = (['previous', 'created'] as const).map((part): ContractCase => ({
  name: `rotation refuses a ${part} session of another organization`,
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO user_account (id, org_id, email) VALUES ('U', ?, 'u@example.test')",
      own.orgId,
    );
    for (const id of ['previous', 'created'])
      await seed(
        "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, 'U', ?, ?, ?, ?)",
        id,
        id === part ? foreign.orgId : own.orgId,
        id === 'previous' ? hash : 'b'.repeat(64),
        'c'.repeat(64),
        stamp,
        '2099-01-01T00:00:00.000Z',
      );
    await context.executor.batch([
      context.mutate(revokePreviousStatement(own, hash, 'created', stamp)),
    ]);
    const rows = await context.executor.all({
      sql: "SELECT revoked_at FROM session WHERE id = 'previous'",
      params: [],
    });
    expect(rows).toEqual([{ revoked_at: null }]);
  },
}));

export const entries: readonly MutationEntry[] = [
  {
    builder: 'revokeAllForUserStatement',
    file: 'repositories/session.ts',
    cases: [revokeSparesForeignSessions],
    predicates: [
      {
        name: 'session rows are scoped to the organization',
        locate: ref('session', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: revokeSparesForeignSessions.name,
      },
    ],
  },
  {
    builder: 'sessionInsertStatement',
    file: 'repositories/session.ts',
    cases: [sessionNotMintedForForeignUser],
    predicates: [
      {
        name: 'the user row is scoped to the organization',
        locate: ref('user_account', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: sessionNotMintedForForeignUser.name,
      },
    ],
  },
  {
    builder: 'revokePreviousStatement',
    file: 'repositories/session.ts',
    cases: rotationCases,
    predicates: ['session', 'created'].map((alias, index) => ({
      name: `${alias} belongs to the organization`,
      locate: new RegExp(`"${alias}"\\."org_id" = \\?`),
      neutral: '(? is not null)',
      copies: 1,
      caseName: rotationCases[index]!.name,
    })),
  },
];
