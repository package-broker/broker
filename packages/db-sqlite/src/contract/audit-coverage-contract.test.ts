import { readdirSync, readFileSync } from 'node:fs';
import { IMPORT_ACTIONS } from '@package-broker/core/api/routes/import.schemas';
import { AUDIT_ACTIONS } from '@package-broker/core/audit/actions';
import { completeIdentityLogin } from '@package-broker/core/auth/identity-login';
import { reauthenticateWithIdentity } from '@package-broker/core/auth/identity-reauth';
import { createLocalLoginService } from '@package-broker/core/auth/local-login';
import { hashPassword } from '@package-broker/core/auth/password';
import { createSessionService } from '@package-broker/core/auth/session';
import { encodeTotpEnvelope, totpCode } from '@package-broker/core/auth/totp';
import { ulid } from '@package-broker/core/ids';
import type { IdentityProvider, VerifiedIdentity } from '@package-broker/core/identity/port';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createLoginWriter } from '../repositories/login.js';
import { createLocalLoginReader } from '../repositories/local-login.js';
import { createLocalLoginSuccessWriter } from '../repositories/local-login-success.js';
import { createSessionRepository } from '../repositories/session.js';
import { createUserRepository } from '../repositories/user.js';
import { seedBindings, seedSubject } from '../testing/mutation-table/fixtures.js';
import { seeder, type CaseContext } from '../testing/mutation-table/harness.js';
import { describe, expect, it } from 'vitest';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import {
  AUDIT_COVERAGE,
  AUDIT_INJECTED_STATEMENTS,
  AUDIT_SECURITY_ATTEMPTS,
  AUDIT_UNCAPTURED,
  describeAuditCoverageContract,
} from './audit-coverage-contract.js';

const packages = new URL('../../../', import.meta.url);
const repositories = new URL('../repositories/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, packages), 'utf8');
const producerSources = [
  'core/src/',
  'db-sqlite/src/repositories/',
  'runtime-node/src/',
  'runtime-cloudflare/src/',
  'cli/src/',
].flatMap((root) =>
  readdirSync(new URL(root, packages), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => `${root}${file}` !== 'core/src/audit/actions.ts')
    .map((file) => ({ path: `${root}${file}`, source: read(`${root}${file}`) })),
);

function literalActions(source: string): string[] {
  return [...source.matchAll(/['"]([a-z_]+\.[a-z_]+)['"]/g)].map((match) => match[1]!);
}

function producedActions(path: string, source: string): string[] {
  const actions = literalActions(source);
  for (const [template, prefix] of source.matchAll(/`([a-z_]+)\.\$\{\w+\}`/g)) {
    if (!AUDIT_ACTIONS.some((action) => action.startsWith(`${prefix}.`))) continue;
    if (path === 'core/src/api/routes/import.ts' && template === '`import_run.${action}`') {
      expect(source).toContain('Object.keys(IMPORT_ACTIONS)');
      actions.push(...Object.keys(IMPORT_ACTIONS).map((action) => `import_run.${action}`));
    } else {
      expect({ path, template }).toEqual({
        path: 'core/src/authz/project-service.ts',
        template: '`project.${action}`',
      });
      expect(source).toContain("action: 'archive' | 'restore'");
      actions.push('project.archive', 'project.restore');
    }
  }
  return actions;
}

describe('audit coverage inventory', () => {
  it('accounts for every declared action, including declared actions without a producer', () => {
    const captured = new Set([
      ...AUDIT_COVERAGE.flatMap((entry) => entry.actions),
      ...AUDIT_INJECTED_STATEMENTS.flatMap((entry) => entry.actions),
    ]);
    const uncaptured = AUDIT_UNCAPTURED.map((entry) => entry.action);
    expect(uncaptured.every((action) => !captured.has(action))).toBe(true);
    expect([...captured, ...uncaptured].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it('pins all direct staging sites so new repository paths and calls require inventory review', () => {
    for (const builder of ['auditPendingStatement', 'visibilityAuditStatements']) {
      const actual = readdirSync(repositories)
        .filter(
          (name) =>
            name.endsWith('.ts') &&
            !name.endsWith('.test.ts') &&
            name !==
              (builder === 'auditPendingStatement' ? 'audit-pending.ts' : 'visibility-audit.ts'),
        )
        .map((name) => ({
          repository: name.slice(0, -3),
          stagingCalls: [
            ...readFileSync(new URL(name, repositories), 'utf8').matchAll(
              new RegExp(`\\b${builder}\\s*\\(`, 'g'),
            ),
          ].length,
        }))
        .filter((entry) => entry.stagingCalls > 0)
        .sort((a, b) => a.repository.localeCompare(b.repository));
      expect(actual).toEqual(
        AUDIT_COVERAGE.filter(
          (entry) => (entry.stagingBuilder ?? 'auditPendingStatement') === builder,
        )
          .map(({ repository, stagingCalls }) => ({ repository, stagingCalls }))
          .sort((a, b) => a.repository.localeCompare(b.repository)),
      );
    }
    expect(
      producerSources
        .map(({ path, source }) => ({
          path,
          calls: [...source.matchAll(/\bauditStatement\s*\(/g)].length,
        }))
        .filter(({ calls }) => calls > 0)
        .sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual(
      AUDIT_INJECTED_STATEMENTS.map(({ caller }) => ({ path: caller, calls: 1 })).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    );
  });

  it('keeps caller, repository, batch guard and cardinality references reviewable', () => {
    for (const entry of AUDIT_COVERAGE) {
      expect(entry.actions.length).toBeGreaterThan(0);
      expect(entry.callers.length).toBeGreaterThan(0);
      const callerActions = entry.callers.flatMap((caller) => {
        const source = read(caller);
        const actions = producedActions(caller, source);
        for (const builder of entry.callerBuilders ?? []) {
          if (builder.caller !== caller) continue;
          expect(source).toContain(builder.call);
          const builderSource = read(builder.builderFile);
          if (builder.bridge !== undefined) {
            expect(read(builder.bridge.file)).toContain(builder.call.split('.').at(-1)!);
            expect(read(builder.bridge.file)).toContain(builder.bridge.call);
            expect(builderSource).toContain(builder.bridge.builder);
          } else expect(builderSource).toContain(builder.call.split('.').at(-1)!);
          const built = producedActions(builder.builderFile, builderSource);
          for (const action of builder.actions) expect(built).toContain(action);
          actions.push(...builder.actions);
        }
        expect(
          actions.some((action) => entry.actions.some((expected) => expected === action)),
          caller,
        ).toBe(true);
        return actions;
      });
      for (const action of entry.actions) expect(callerActions, entry.repository).toContain(action);
      expect(read(`db-sqlite/src/repositories/${entry.repository}.ts`)).toContain(
        entry.stagingBuilder ?? 'auditPendingStatement',
      );
      expect(entry.batchGuard.length).toBeGreaterThan(0);
      expect(entry.cardinality.length).toBeGreaterThan(0);
    }
    for (const entry of AUDIT_INJECTED_STATEMENTS) {
      for (const action of entry.actions)
        expect(producedActions(entry.caller, read(entry.caller))).toContain(action);
      expect(read(entry.service)).toContain('audit:');
      expect(read(entry.wiring)).toContain('auditStatement: auditPendingStatement');
      expect(read(entry.repository)).toContain('input.audit');
    }
  });

  it('records logout fallback coverage separately from uncaptured failed security attempts', () => {
    expect(
      AUDIT_SECURITY_ATTEMPTS.filter(({ captured }) => captured).map(({ attempt }) => attempt),
    ).toEqual(['logout sanitizer refusal']);
    expect(AUDIT_SECURITY_ATTEMPTS.map(({ attempt }) => attempt)).toEqual([
      'failed login',
      'authorization denial',
      'failed reauthentication',
      'logout without active session',
      'logout sanitizer refusal',
    ]);
    for (const { action } of AUDIT_UNCAPTURED) {
      expect(AUDIT_ACTIONS).toContain(action);
      expect(
        producerSources
          .filter(({ path, source }) => producedActions(path, source).includes(action))
          .map(({ path }) => path),
      ).toEqual([]);
    }
  });
});

describe('failed credential checks currently stage no audit rows', () => {
  const now = '2026-10-28T00:00:00.000Z';
  const meta = {
    requestId: '01K7R5V0000000000000000002',
    ip: null,
    userAgent: null,
    previousSecretHash: null,
  };
  async function fixture(
    body: (
      db: Awaited<ReturnType<typeof openMigratedDatabase>>,
      context: CaseContext,
    ) => Promise<void>,
  ) {
    const database = await openMigratedDatabase({ twoOrganizations: true });
    try {
      if (database.orgs === null) throw new Error('organizations were not seeded');
      await body(database, {
        executor: database.executor,
        orgs: database.orgs,
        mutate: (s) => s,
        mutateBatch: (s) => s,
      });
    } finally {
      await database.close();
    }
  }
  const pending = (context: CaseContext) =>
    context.executor.all({
      sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
      params: [context.orgs.a.orgId],
    });

  it('failed local password verification stages zero rows; valid credentials still stage login', async () => {
    await fixture(async ({ executor }, context) => {
      const ctx = context.orgs.a;
      const seed = seeder(executor);
      await seedBindings(context);
      const actor = await seedSubject(context, 'local');
      await seed(
        "UPDATE role SET protects_last_holder = 1 WHERE org_id = ? AND id = 'R-local'",
        ctx.orgId,
      );
      const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
      const secret = new Uint8Array(20).fill(9);
      const password = 'audit-fixture-password';
      const passwordHash = await hashPassword(password, keyring);
      await seed(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('totp', ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
        ctx.orgId,
      );
      await seed(
        'INSERT INTO local_login (org_id, user_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?, ?)',
        ctx.orgId,
        actor.userId,
        passwordHash,
        'totp',
        now,
      );
      const service = createLocalLoginService({
        reader: createLocalLoginReader(executor),
        writer: createLocalLoginSuccessWriter(executor),
        credentials: {
          read: async () => encodeTotpEnvelope(actor.userId, secret),
          prepare: async () => {
            throw new Error('unexpected prepare');
          },
          seal: async () => {
            throw new Error('unexpected seal');
          },
          put: async () => {
            throw new Error('unexpected put');
          },
          resealBatch: async () => {
            throw new Error('unexpected reseal');
          },
        },
        sessions: createSessionRepository(executor),
        sessionCookies: { setCookies: () => [] },
        keyring,
        clock: { now: () => new Date(now) },
        ids: { ulid },
      });
      const input = {
        email: 'local@example.test',
        password,
        code: await totpCode(secret, Math.floor(Date.parse(now) / 30_000)),
      };
      expect(await service.login(ctx, { ...input, password: 'wrong-password' }, meta)).toEqual({
        ok: false,
      });
      expect(
        await executor.all({
          sql: 'SELECT failed_count FROM local_login WHERE org_id = ? AND user_id = ?',
          params: [ctx.orgId, actor.userId],
        }),
      ).toEqual([{ failed_count: 1 }]);
      expect(await pending(context)).toEqual([]);
      expect((await service.login(ctx, input, meta)).ok).toBe(true);
      expect(await pending(context)).toEqual([{ action: 'session.login' }]);
    });
  });

  it('failed identity login and identity reauth stage zero rows; valid evidence stages events', async () => {
    await fixture(async ({ executor }, context) => {
      const ctx = context.orgs.a;
      let stamp = now;
      const clock = { now: () => new Date(stamp) };
      const sessions = createSessionRepository(executor);
      const users = createUserRepository(executor);
      const hooks = { 'auth.resolveIdentity': [], 'auth.mapGroups': [] };
      const provider: IdentityProvider = {
        id: 'oidc',
        kind: 'oidc',
        displayName: 'Fixture',
        trustAnchor: 'oidc:https://idp.example.test',
        policy: {
          verifiedDomains: ['example.test'],
          emailAuthoritativeDomains: ['example.test'],
          autoJoin: true,
        },
        supportsReauth: true,
        start: async () => {
          throw new Error('unexpected start');
        },
        finish: async () => {
          throw new Error('unexpected finish');
        },
      };
      const identity: VerifiedIdentity = {
        provider: 'oidc',
        subject: 'subject',
        email: 'identity@example.test',
        emailVerified: true,
        displayName: null,
        groups: [],
        issuedAt: now,
        authTime: now,
      };
      const deps = {
        users,
        writer: createLoginWriter(executor),
        sessions: createSessionService({ sessions, clock, publicOrigin: 'https://broker.test' }),
        clock,
        ids: { ulid },
        hooks,
      };
      expect(
        await completeIdentityLogin(
          deps,
          ctx,
          provider,
          { ...identity, emailVerified: false },
          meta,
        ),
      ).toEqual({ ok: false, reason: 'email_unverified' });
      expect(await pending(context)).toEqual([]);
      const login = await completeIdentityLogin(deps, ctx, provider, identity, meta);
      expect(login.ok).toBe(true);
      if (!login.ok) throw new Error('fixture login failed');
      expect(await pending(context)).toEqual([{ action: 'session.login' }]);
      await executor.batch([
        { sql: 'DELETE FROM audit_pending WHERE org_id = ?', params: [ctx.orgId] },
      ]);
      stamp = '2026-10-28T00:01:00.000Z';
      const session = await sessions.findActiveById(ctx, login.sessionId, {
        now: stamp,
        idleSince: '2026-10-27T23:00:00.000Z',
      });
      if (session === null) throw new Error('fixture session inactive');
      const authenticated = { session, principal: { kind: 'user' as const, id: login.userId } };
      const state = {
        provider: provider.id,
        purpose: 'reauth',
        sessionId: login.sessionId,
        issuedAt: Date.parse(stamp),
      };
      const evidence = { ...identity, issuedAt: stamp, authTime: stamp };
      const reauthDeps = { users, sessions, clock, hooks };
      expect(
        await reauthenticateWithIdentity(
          reauthDeps,
          ctx,
          authenticated,
          provider,
          { ...evidence, subject: 'wrong-subject' },
          state,
          meta,
        ),
      ).toEqual({ ok: false, reason: 'identity_mismatch' });
      expect(await pending(context)).toEqual([]);
      expect(
        await reauthenticateWithIdentity(
          reauthDeps,
          ctx,
          authenticated,
          provider,
          evidence,
          state,
          meta,
        ),
      ).toEqual({ ok: true });
      expect(await pending(context)).toEqual([{ action: 'session.reauth' }]);
    });
  });
});

describeAuditCoverageContract(async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  return {
    executor: database.executor,
    ctx: database.orgs.a,
    foreign: database.orgs.b,
    close: () => database.close(),
  };
});
