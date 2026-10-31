import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { expect, vi } from 'vitest';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createNpmLoginRepository } from '../../repositories/npm-login.js';
import { createNpmLoginExpiryRepository } from '../../repositories/npm-login-expire.js';
import { executing } from './factory-cases.js';
import { seedProject } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
const foreignConfirmation: ContractCase = {
  name: 'login confirmation refuses another organization selector',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'foreign-project', foreign.orgId);
    await seed(
      "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at) VALUES ('login',?,'foreign-project',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'))",
      foreign.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
    );
    const repo = createNpmLoginRepository(
      executing(context),
      createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
    );
    expect(await repo.confirmation(own, 'a'.repeat(64))).toBeNull();
  },
};
const foreignStart: ContractCase = {
  name: 'login start refuses another organization project',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedProject(seeder(context.executor), 'foreign-project', foreign.orgId);
    const repo = createNpmLoginRepository(
      executing(context),
      createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
    );
    expect(
      await repo.start(own, {
        id: 'login',
        projectId: 'foreign-project',
        selectorHash: 'a'.repeat(64),
        doneHash: 'b'.repeat(64),
        hostname: null,
        sourceIp: null,
      }),
    ).toBe(false);
  },
};
const foreignPoll: ContractCase = {
  name: 'login poll refuses another organization pending session',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'foreign-project', foreign.orgId);
    await seed(
      "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at) VALUES ('login',?,'foreign-project',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'))",
      foreign.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
    );
    const repo = createNpmLoginRepository(
      executing(context),
      createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
    );
    expect(await repo.poll(own, 'foreign-project', 'b'.repeat(64))).toEqual({
      status: 'not_found',
    });
  },
};
const foreignApprove: ContractCase = {
  name: 'login approval refuses another organization selector before issuing a token',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'foreign-project', foreign.orgId);
    await seed(
      "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at) VALUES ('login',?,'foreign-project',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'))",
      foreign.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
    );
    const repo = createNpmLoginRepository(
      executing(context),
      createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
    );
    const now = new Date().toISOString();
    const audit = auditEvent({
      id: ulid(),
      now,
      action: 'token.issue',
      actor: { type: 'user', id: 'user' },
      context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      target: { type: 'token', id: 'token' },
      projectId: null,
    });
    if (!audit.ok) throw new Error('fixture audit');
    expect(
      await repo.approveNpmLogin(
        own,
        mutationFence({ userId: 'user', sessionId: 'session' } as AuthenticatedActor, {}),
        {
          id: 'token',
          name: 'npm login',
          scope: 'read',
          expiresAt: '2099-01-01T00:00:00.000Z',
          maxLifetimeDays: 365,
          now,
          validation: { kind: 'sso', identityId: 'identity' },
          projectMode: 'selected',
          projectIds: ['foreign-project'],
          providerAnchors: [],
          audit: audit.event,
        },
        () => {
          expect.fail('A foreign login selector must never reach token minting');
        },
        'a'.repeat(64),
      ),
    ).toEqual({ status: 'refused', reason: 'id_conflict' });
  },
};
const foreignExpiry: ContractCase = {
  name: 'expiry does not select another organization sessions',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'foreign-project', foreign.orgId);
    await seed(
      "INSERT INTO npm_login_session (id,org_id,project_id,selector_hash,done_hash,expires_at) VALUES ('login',?,'foreign-project',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))",
      foreign.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
    );
    const executor = executing(context);
    const batch = vi.fn(executor.batch);
    expect(await createNpmLoginExpiryRepository({ ...executor, batch }).expire(own)).toBe(0);
    expect(batch).not.toHaveBeenCalled();
  },
};
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/npm-login.ts',
    builder: 'createNpmLoginRepository',
    waivers: [
      {
        locate: /(?<=FROM npm_login_session WHERE )org_id = \?/,
        reason:
          'Start session counts are organization scoped abuse limits; the project ownership predicate has an executable foreign project case.',
      },
      {
        locate: /(?<=WHERE )org_id = \?(?= AND project_id)/,
        reason:
          'The approved poll read and CAS share the same scope; the pending poll predicate has an executable foreign session case.',
      },

      {
        locate: /p\.org_id = l\.org_id/,
        reason:
          'The join keeps the project in the session organization; the outer l.org_id predicate supplies caller scope.',
      },
    ],
    cases: [foreignConfirmation, foreignStart, foreignPoll, foreignApprove],
    predicates: [
      {
        name: 'start project organization',
        locate: /(?<=FROM project WHERE )org_id = \?/,
        neutral: '? IS NOT NULL',
        caseName: foreignStart.name,
      },
      {
        name: 'pending poll organization',
        locate: /(?<=SELECT 1 FROM npm_login_session WHERE )org_id = \?/,
        neutral: '? IS NOT NULL',
        caseName: foreignPoll.name,
      },
      // Approval resolves the selector through confirmation before issuing a token.
      {
        name: 'confirmation organization',
        locate: /l\.org_id = \?/,
        neutral: '? IS NOT NULL',
        caseName: foreignConfirmation.name,
      },
    ],
  },
  {
    file: 'repositories/npm-login-expire.ts',
    builder: 'createNpmLoginExpiryRepository',
    cases: [foreignExpiry],
    waivers: [
      {
        locate: /t\.org_id = npm_login_session\.org_id/,
        reason:
          'The retained-row exclusion correlates the token with the outer session row, which the registered expiry organization predicate already scopes.',
      },
    ],
    predicates: [
      {
        name: 'expiry organization',
        locate: /org_id = \?/,
        neutral: '? IS NOT NULL',
        caseName: foreignExpiry.name,
      },
    ],
  },
];
