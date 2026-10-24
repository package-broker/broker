import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { expect } from 'vitest';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createIdentityBlockRepository } from '../../repositories/identity-block.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ALWAYS, ANCHORS, NOT_NULL, fenceOf, seedBindings, seedSubject } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignBlock: ContractCase = {
  name: 'identity unblocking preserves a foreign block child of an own actor',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedBindings(context);
    const subject = await seedSubject(context, 'actor');
    await seed("UPDATE role SET protects_last_holder = 1 WHERE id = 'R-actor'");
    await seed(
      "UPDATE session SET reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      subject.sessionId,
    );
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-actor', 'org:users:write')",
      own.orgId,
    );
    const issuer = ANCHORS[0]!.anchor;
    await seed(
      "INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_by_user_id) VALUES (?, 'oidc', ?, 'blocked', ?)",
      foreign.orgId,
      issuer,
      subject.userId,
    );
    await seed(
      "INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_by_user_id) VALUES (?, 'oidc', ?, 'blocked', ?)",
      own.orgId,
      issuer,
      subject.userId,
    );
    await expect(
      createIdentityBlockRepository(executing(context), {
        holderInput: () => ({ kind: 'fresh', now: new Date().toISOString(), providers: ANCHORS }),
      }).unblock(
        own,
        fenceOf(subject),
        { provider: 'oidc', issuer, subject: 'blocked' },
        unblockAudit(),
      ),
    ).resolves.toBe('unblocked');
    expect(
      await context.executor.all({
        sql: "SELECT subject FROM identity_block WHERE subject = 'blocked'",
        params: [],
      }),
    ).toEqual([{ subject: 'blocked' }]);
  },
};
const entry = factoryEntry(
  'identity-block',
  'createIdentityBlockRepository',
  foreignBlock,
  /"identity_block"\."org_id" = \?/,
  [
    {
      locate: /(?<=cache_epoch[^;]{0,100})"org_id" = \?/,
      reason:
        'runOrgFenced delegates the unchanged epoch read and bump; cache-epoch and cache-epoch-bump have independent organization registrations.',
    },
    {
      locate: /"(?:guard_\w+|la_session|hp_session|present)"\."org_id" = |(?:au|s)\.org_id = /,
      reason:
        'The actor is an own control; live session, permissionRows and protected-holder authority are independently covered by access and service-principal authority registrations. The present predicate gates the audit insert and classifies a failed deletion; the foreign-block case covers the delete organization scope while the matching own block satisfies presence.',
    },
  ],
);

// Project the compiled session EXISTS to test scopes that permissionRows also enforces.
function sessionProjection(statement: Statement): Statement | undefined {
  const start = statement.sql.indexOf('exists (select "s"."id" from "session" as "s"');
  if (start < 0) return undefined;
  const tokens = /'(?:[^']|'')*'|"(?:[^"]|"")*"|[()?]/g;
  tokens.lastIndex = start;
  let depth = 0;
  let parameters = 0;
  for (let token = tokens.exec(statement.sql); token !== null; token = tokens.exec(statement.sql)) {
    if (token[0] === '?') parameters += 1;
    if (token[0] === '(') depth += 1;
    if (token[0] === ')' && --depth === 0) {
      const offset = (statement.sql.slice(0, start).match(/\?/g) ?? []).length;
      return {
        sql: `select ${statement.sql.slice(start, tokens.lastIndex)} as live`,
        params: statement.params.slice(offset, offset + parameters),
      };
    }
  }
  throw new Error('compiled actor session is incomplete');
}

const sessionCases = (['actor', 'identity', 'session'] as const).map((layer): ContractCase => ({
  name: `unblock guard and authority probe refuse a foreign ${layer}`,
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedBindings(context);
    const subject = await seedSubject(context, 'actor');
    await seed("UPDATE role SET protects_last_holder = 1 WHERE id = 'R-actor'");
    await seed(
      "UPDATE role_permission SET permission = 'org:users:write' WHERE role_id = 'R-actor'",
    );
    await seed(
      "UPDATE session SET identity_id = 'I-actor', reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      subject.sessionId,
    );
    const key = { provider: 'oidc', issuer: ANCHORS[0]!.anchor, subject: 'blocked' };
    const block = () =>
      seed(
        'INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_by_user_id) VALUES (?, ?, ?, ?, ?)',
        own.orgId,
        key.provider,
        key.issuer,
        key.subject,
        subject.userId,
      );
    const options = {
      holderInput: () => ({
        kind: 'fresh' as const,
        now: new Date().toISOString(),
        providers: ANCHORS,
      }),
    };
    await block();
    expect(
      await createIdentityBlockRepository(context.executor, options).unblock(
        own,
        fenceOf(subject),
        key,
        unblockAudit(),
      ),
    ).toBe('unblocked');
    await block();
    if (layer === 'identity') {
      await seed.forged('UPDATE identity SET org_id = ? WHERE id = ?', foreign.orgId, 'I-actor');
    } else {
      await seed('UPDATE session SET identity_id = NULL WHERE id = ?', subject.sessionId);
      await seed.forged(
        'UPDATE user_account SET org_id = ? WHERE id = ?',
        foreign.orgId,
        subject.userId,
      );
      if (layer === 'session') {
        await seed.forged(
          'UPDATE session SET org_id = ? WHERE id = ?',
          foreign.orgId,
          subject.sessionId,
        );
      }
    }
    const live: number[] = [];
    const observe = async (statement: Statement) => {
      const projected = sessionProjection(context.mutate(statement));
      if (projected === undefined) return;
      const rows = await context.executor.all<{ live: number }>(projected);
      live.push(rows[0]!.live);
    };
    const executor: SqlExecutor = {
      driver: context.executor.driver,
      async all<R = Record<string, unknown>>(statement: Statement) {
        await observe(statement);
        return context.executor.all<R>(statement);
      },
      async batch(statements) {
        for (const statement of statements) await observe(statement);
        return context.executor.batch(statements);
      },
    };
    expect(
      await createIdentityBlockRepository(executor, options).unblock(
        own,
        fenceOf(subject),
        key,
        unblockAudit(),
      ),
    ).toBe('authority');
    // Observe all copies independently even when another authority condition refuses the batch.
    expect(live).toEqual([0, 0, 0]);
    expect(
      await context.executor.all({
        sql: 'SELECT subject FROM identity_block WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toEqual([{ subject: 'blocked' }]);
  },
}));

export const entries: readonly MutationEntry[] = [
  {
    ...entry,
    cases: [...entry.cases, ...sessionCases],
    predicates: [
      ...entry.predicates,
      ...sessionCases.map((contractCase, index) => ({
        name: contractCase.name,
        caseName: contractCase.name,
        locate: [
          /"actor"\."org_id" = "s"\."org_id"/,
          /"i"\."org_id" = "s"\."org_id"/,
          /"s"\."org_id" = \?/,
        ][index]!,
        neutral: index === 2 ? NOT_NULL : ALWAYS,
        copies: 3,
      })),
    ],
  },
];

function unblockAudit() {
  const id = ulid();
  const result = auditEvent({
    id,
    now: new Date().toISOString(),
    action: 'identity.unblock',
    actor: { type: 'system', id: null },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
    target: { type: 'identity_block', id: null },
  });
  if (!result.ok) throw new Error('Invalid test audit event');
  return result.event;
}
