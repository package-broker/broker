import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { auditEvent } from '@package-broker/core/audit/actions';
import {
  buildIdempotencyRecord,
  replayResponse,
  settleIdempotent,
} from '@package-broker/core/api/idempotency';
import {
  createServiceTokenService,
  type ServiceTokenRotateStoreInput,
} from '@package-broker/core/authz/service-token-service';
import type { AuthenticatedSession } from '@package-broker/core/auth/session';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { fixedClock } from '@package-broker/core/ids';
import { openMigratedDatabase, discoveredMigrations } from '../testing/migrated-database.js';
import { migrate } from '../migrations/runner.js';
import { seedTwoOrganizations } from '../contract/two-organizations.js';
import { createAccessRepository } from './access.js';
import { createTokenRepository, type MintedToken } from './token.js';
import { createIdempotencyRepository } from './idempotency.js';
const USER = '01J0USER000000000000000001';
const OTHER_USER = '01J0USER000000000000000002';
const SESSION = '01J0SESSION0000000000000001';
const ADMIN_ROLE = '01J0ROLE000000000000000001';
const PROJECT = '01J0PROJECT000000000000001';
const OTHER_PROJECT = '01J0PROJECT000000000000002';
const SP = '01J0SERVICE000000000000001';
const SP_WIDE = '01J0SERVICE000000000000002';
const TOKEN = '01J0TOKEN0000000000000000A';
const ANCHORS = [
  {
    provider: 'idp',
    anchor: 'anchor-1',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const DAY = 86_400_000;
const ISSUER_PERMISSIONS = [
  'org:service-principals:write',
  'project:audit:read',
  'project:packages:read',
  'project:packages:write',
  'project:read',
  'project:tokens:create',
  'project:tokens:revoke',
  'org:tokens:revoke',
];

let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;
let close: () => Promise<void>;
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const fence = () =>
  mutationFence({ userId: USER, sessionId: SESSION } as unknown as AuthenticatedActor, {});
function mint(selector = 'bbbbbbbbbbbb'): MintedToken {
  return {
    selector,
    hash: 'a'.repeat(64),
    pepperVersion: 1,
    plaintext: `pb_svc_${selector}_${'x'.repeat(43)}`,
  };
}
async function seed() {
  await executor.batch([
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      USER,
      a.orgId,
      'user@example.test',
      'active',
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      OTHER_USER,
      a.orgId,
      'other@example.test',
      'active',
    ),
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1)',
      ADMIN_ROLE,
      a.orgId,
      'organization_admin',
      'Admin',
      'organization',
    ),
    ...ISSUER_PERMISSIONS.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        ADMIN_ROLE,
        permission,
      ),
    ),
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'idp', 'anchor-1')",
      a.orgId,
    ),
    stmt(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDENTIAL000000000001', ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      a.orgId,
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'email', ?, NULL, 'organization', NULL, ?)",
      '01J0GRANT000000000000000001',
      a.orgId,
      'user@example.test',
      ADMIN_ROLE,
    ),
    stmt(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$i=1$v=1$c2FsdA$aGFzaA', '01J0CREDENTIAL000000000001', ?, ?)",
      USER,
      a.orgId,
      iso(-3_600_000),
      iso(-3_600_000),
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      a.orgId,
      USER,
      'a'.repeat(64),
      'b'.repeat(64),
      iso(3_600_000),
      iso(-60_000),
    ),
    stmt(
      "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha'), (?, ?, 'beta', 'Beta')",
      PROJECT,
      a.orgId,
      OTHER_PROJECT,
      a.orgId,
    ),
    stmt(
      "INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, 'ci', ?, ?), (?, ?, 'wide', NULL, ?)",
      SP,
      a.orgId,
      PROJECT,
      USER,
      SP_WIDE,
      a.orgId,
      USER,
    ),
    stmt(
      "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, 'project:packages:read'), (?, ?, 'project:packages:write'), (?, ?, 'project:read'), (?, ?, 'project:read')",
      a.orgId,
      SP,
      a.orgId,
      SP,
      a.orgId,
      SP,
      a.orgId,
      SP_WIDE,
    ),
  ]);
}
function audit(action: 'token.issue' | 'token.rotate') {
  const id = ulid();
  const result = auditEvent({
    id,
    now: iso(0),
    action,
    actor: { type: 'user', id: USER },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
    target: { type: 'token', id: TOKEN },
    projectId: PROJECT,
  });
  if (!result.ok) throw new Error('invalid fixture audit');
  return result.event;
}
function input(extra: Partial<ServiceTokenRotateStoreInput> = {}): ServiceTokenRotateStoreInput {
  return {
    id: ulid(),
    tokenId: TOKEN,
    overlapDays: 7,
    name: 'deploy',
    servicePrincipalId: SP,
    projectId: PROJECT,
    principalRevision: 1,
    scope: 'read',
    readOnly: true,
    expiresAt: iso(30 * DAY),
    maxLifetimeDays: 365,
    now: iso(0),
    authority: {
      permission: 'project:tokens:create',
      organizationAdmin: false,
      covers: ['project:packages:read', 'project:read'],
    },
    providerAnchors: ANCHORS,
    audit: audit('token.issue'),
    rotationAudit: audit('token.rotate'),
    ...extra,
  };
}
function rotationRecord(request: ServiceTokenRotateStoreInput) {
  return buildIdempotencyRecord({
    principal: { kind: 'user', id: USER },
    key: 'rotate-once',
    route: '/_pb/projects/:project/tokens/:token/rotate',
    hash: 'ab'.repeat(32),
    status: 409,
    response: { code: 'already_issued', id: request.id },
    now: new Date(request.now),
  });
}
async function oldToken(projectId: string | null = PROJECT, expiresAt = iso(30 * DAY)) {
  await executor.batch([
    stmt(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json,
      read_only, service_principal_id, project_id, created_by_user_id, expires_at, project_mode)
      VALUES (?, ?, 'svc', 'aaaaaaaaaaaa', ?, 1, 'deploy', ?, ?, ?, ?, ?, ?, ?)`,
      TOKEN,
      a.orgId,
      'a'.repeat(64),
      projectId === null ? '["full"]' : '["read"]',
      projectId === null ? 0 : 1,
      projectId === null ? SP_WIDE : SP,
      projectId,
      OTHER_USER,
      expiresAt,
      projectId === null ? 'all' : 'selected',
    ),
  ]);
}
async function rows(table: string) {
  return executor.all<Record<string, unknown>>(
    stmt(`SELECT * FROM ${table} WHERE org_id = ?`, a.orgId),
  );
}
async function oldRow() {
  return (await rows('token')).find((row) => row['id'] === TOKEN)!;
}
const rotate = (
  extra: Partial<ServiceTokenRotateStoreInput> = {},
  repo = createTokenRepository(executor),
) => repo.rotateService(a, fence(), input(extra), mint);
async function nothingAdded() {
  expect(await rows('token')).toHaveLength(1);
  expect(await rows('audit_pending')).toHaveLength(0);
}

beforeEach(async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  close = () => database.close();
  executor = database.executor;
  if (!database.orgs) throw new Error('missing fixture organizations');
  ({ a, b } = database.orgs);
  await seed();
});
afterEach(async () => close());

describe('service token rotation batch', () => {
  it('persists the rotation replay record without plaintext in its organization', async () => {
    await oldToken();
    const request = input();
    const record = rotationRecord(request);
    const result = await rotate({ ...request, idempotency: record });
    expect(result.status).toBe('rotated');
    const replays = createIdempotencyRepository(executor);
    expect(await replays.find(a, record.principalKey, record.key, request.now)).toEqual(record);
    expect(await replays.find(b, record.principalKey, record.key, request.now)).toBeNull();
    expect(await rows('api_idempotency')).toHaveLength(1);
    expect(JSON.parse(record.responseJson)).toEqual({ code: 'already_issued', id: request.id });
    expect(JSON.stringify(await rows('api_idempotency')).includes(mint().plaintext)).toBe(false);
  });
  it.each([7, 0] as const)(
    'replays a repeated rotation with the same key for overlap %i without rotating again',
    async (overlapDays) => {
      await oldToken();
      const request = input({ overlapDays });
      const record = rotationRecord(request);
      expect((await rotate({ ...request, idempotency: record })).status).toBe('rotated');
      const tokens = await rows('token');
      const audits = await rows('audit_pending');
      const retry = input({
        ...request,
        id: ulid(),
        audit: audit('token.issue'),
        rotationAudit: audit('token.rotate'),
      });
      const replays = createIdempotencyRepository(executor);
      const settlement = await settleIdempotent({
        record: rotationRecord(retry),
        hash: record.requestHash,
        now: new Date(request.now),
        find: () => replays.find(a, record.principalKey, record.key, request.now),
        run: () =>
          createTokenRepository(executor).rotateService(
            a,
            fence(),
            { ...retry, idempotency: rotationRecord(retry) },
            () => mint('cccccccccccc'),
          ),
        failed: (result) => result.status !== 'rotated',
      });
      expect(settlement.kind).toBe('replay');
      if (settlement.kind !== 'replay') throw new Error('expected a rotation replay');
      expect(settlement.record).toEqual(record);
      const response = replayResponse(settlement.record, ulid());
      expect(response.status).toBe(409);
      expect(response.headers.get('Idempotent-Replayed')).toBe('true');
      const body = await response.json();
      expect(body).toEqual({
        error: expect.objectContaining({ code: 'already_issued' }),
        id: request.id,
      });
      expect(await rows('token')).toEqual(tokens);
      expect(await rows('audit_pending')).toEqual(audits);
      expect(await rows('api_idempotency')).toHaveLength(1);
    },
  );
  it('leaves no rotation replay record when the old token is revoked between read and batch', async () => {
    await oldToken();
    const repository = createTokenRepository(executor);
    expect(await repository.getService(a, TOKEN)).toMatchObject({ id: TOKEN, revokedAt: null });
    const revokedAt = iso(0);
    await executor.batch([
      stmt(
        'UPDATE token SET revoked_at = ? WHERE org_id = ? AND id = ?',
        revokedAt,
        a.orgId,
        TOKEN,
      ),
    ]);
    const old = await oldRow();
    const request = input();
    const record = rotationRecord(request);
    expect(await rotate({ ...request, idempotency: record }, repository)).toEqual({
      status: 'refused',
      reason: 'conflict',
    });
    expect(await oldRow()).toEqual(old);
    await nothingAdded();
    expect(await rows('api_idempotency')).toHaveLength(0);
    expect(
      await createIdempotencyRepository(executor).find(
        a,
        record.principalKey,
        record.key,
        request.now,
      ),
    ).toBeNull();
  });
  it('overlap 7 preserves binding and scope and lookup accepts the retiring token', async () => {
    await oldToken();
    const request = input();
    const result = await createTokenRepository(executor).rotateService(a, fence(), request, mint);
    expect(result).toMatchObject({
      status: 'rotated',
      id: request.id,
      replacedExpiresAt: new Date(Date.parse(request.now) + 7 * DAY).toISOString(),
    });
    const old = await oldRow();
    expect(old['expires_at']).toBe(new Date(Date.parse(request.now) + 7 * DAY).toISOString());
    expect(old['revoked_at']).toBeNull();
    expect((await rows('token')).find((row) => row['id'] === request.id)).toMatchObject({
      service_principal_id: SP,
      project_id: PROJECT,
      scopes_json: '["read"]',
      read_only: 1,
      created_by_user_id: USER,
      last_op_id: old['last_op_id'],
    });
    expect(
      await createAccessRepository(executor).lookupToken(a, {
        selector: 'aaaaaaaaaaaa',
        boundary: 'project',
        projectSlug: 'alpha',
        providerAnchors: ANCHORS,
      }),
    ).not.toBeNull();
  });
  it('overlap 0 revokes atomically and returns the stored revoked_at', async () => {
    await oldToken();
    const request = input({ overlapDays: 0 });
    const result = await createTokenRepository(executor).rotateService(a, fence(), request, mint);
    expect(result).toMatchObject({ status: 'rotated', replacedExpiresAt: request.now });
    expect((await oldRow())['revoked_at']).toBe(request.now);
    expect(await rows('token')).toHaveLength(2);
    const audits = await rows('audit_pending');
    expect(audits).toHaveLength(2);
    expect(
      JSON.parse(String(audits.find((row) => row['action'] === 'token.rotate')?.['payload_json']))
        .changes.expires_at.new,
    ).toBe(request.now);
  });
  it('caps overlap 7 by the replacement’s one day expiry', async () => {
    await oldToken();
    const expiresAt = iso(DAY);
    expect(await rotate({ expiresAt })).toMatchObject({
      status: 'rotated',
      replacedExpiresAt: expiresAt,
    });
    expect((await oldRow())['expires_at']).toBe(expiresAt);
  });
  it('never extends an old expiry shorter than the overlap', async () => {
    const expiresAt = iso(DAY);
    await oldToken(PROJECT, expiresAt);
    expect(await rotate()).toMatchObject({ status: 'rotated', replacedExpiresAt: expiresAt });
    expect((await oldRow())['expires_at']).toBe(expiresAt);
  });
  it('allows sequential rotations while the retiring token’s expiry never increases', async () => {
    await oldToken();
    expect((await rotate({ overlapDays: 1 })).status).toBe('rotated');
    const first = (await oldRow())['expires_at'];
    const request = input();
    expect(
      (
        await createTokenRepository(executor).rotateService(a, fence(), request, () =>
          mint('cccccccccccc'),
        )
      ).status,
    ).toBe('rotated');
    expect((await oldRow())['expires_at']).toBe(first);
  });
  it('stages exactly one issue and one rotation with the actual expiry', async () => {
    await oldToken();
    const request = input();
    expect(
      (await createTokenRepository(executor).rotateService(a, fence(), request, mint)).status,
    ).toBe('rotated');
    const audits = await rows('audit_pending');
    expect(audits.map((row) => row['action']).sort()).toEqual(['token.issue', 'token.rotate']);
    expect(audits.find((row) => row['action'] === 'token.rotate')).toMatchObject({
      target_id: TOKEN,
    });
    const payload = JSON.parse(
      String(audits.find((row) => row['action'] === 'token.rotate')?.['payload_json']),
    );
    expect(payload.changes).toEqual({
      replacement_id: { new: request.id },
      overlap_days: { new: 7 },
      expires_at: { new: (await oldRow())['expires_at'] },
    });
    expect(JSON.stringify(audits)).not.toContain(mint().plaintext);
  });
  it('aborts when the old token is revoked after getService and before the batch', async () => {
    await oldToken();
    const repository = createTokenRepository(executor);
    expect(await repository.getService(a, TOKEN)).toMatchObject({ id: TOKEN, revokedAt: null });
    await executor.batch([
      stmt('UPDATE token SET revoked_at = ? WHERE org_id = ? AND id = ?', iso(0), a.orgId, TOKEN),
    ]);
    expect(await rotate({}, repository)).toEqual({ status: 'refused', reason: 'conflict' });
    await nothingAdded();
  });
  it('refuses rotation of a package-bound workload token, including a binding race', async () => {
    await oldToken();
    const repository = createTokenRepository(executor);
    expect(await repository.getService(a, TOKEN)).not.toBeNull();
    await executor.batch([
      stmt('UPDATE token SET package_name = ? WHERE org_id = ? AND id = ?', 'test', a.orgId, TOKEN),
    ]);
    expect(await repository.getService(a, TOKEN)).toBeNull();
    expect(await rotate({}, repository)).toEqual({ status: 'refused', reason: 'conflict' });
    await nothingAdded();
  });
  it('aborts when the old token expires before the batch', async () => {
    await oldToken(PROJECT, iso(-1000));
    expect(await rotate()).toEqual({ status: 'refused', reason: 'conflict' });
    await nothingAdded();
  });
  it('rechecks revoke authority in the batch', async () => {
    await oldToken();
    await executor.batch([
      stmt(
        "DELETE FROM role_permission WHERE org_id = ? AND role_id = ? AND permission = 'project:tokens:revoke'",
        a.orgId,
        ADMIN_ROLE,
      ),
    ]);
    expect(await rotate()).toEqual({ status: 'refused', reason: 'authority' });
    await nothingAdded();
  });
  it('reuses the issue guard’s lifetime maximum on database time', async () => {
    await oldToken();
    expect(await rotate({ maxLifetimeDays: 1 })).toEqual({
      status: 'refused',
      reason: 'authority',
    });
    await nothingAdded();
  });
  it('aborts when the old-token update does not carry this operation marker', async () => {
    await oldToken();
    const skip: SqlExecutor = {
      driver: executor.driver,
      all: (s) => executor.all(s),
      batch: (statements) =>
        executor.batch(
          statements.map((s) => (/update "token"/i.test(s.sql) ? stmt('SELECT 1') : s)),
        ),
    };
    expect(await rotate({}, createTokenRepository(skip))).toEqual({
      status: 'refused',
      reason: 'conflict',
    });
    await nothingAdded();
  });
  it('retries a selector collision without leaving a partial rotation or audit', async () => {
    await oldToken();
    let calls = 0;
    const result = await createTokenRepository(executor).rotateService(a, fence(), input(), () =>
      mint(++calls === 1 ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb'),
    );
    expect(result.status).toBe('rotated');
    expect(calls).toBe(2);
    expect(await rows('token')).toHaveLength(2);
    expect(await rows('audit_pending')).toHaveLength(2);
  });
  it('getService reads no secret columns and hides a token from another organization', async () => {
    await oldToken();
    const repository = createTokenRepository(executor);
    expect(await repository.getService(a, TOKEN)).toEqual({
      id: TOKEN,
      servicePrincipalId: SP,
      projectId: PROJECT,
      scope: 'read',
      readOnly: true,
      name: 'deploy',
      expiresAt: (await oldRow())['expires_at'],
      revokedAt: null,
    });
    expect(await repository.getService(b, TOKEN)).toBeNull();
  });
  it('uses at most 100 bound parameters in every rotation statement', async () => {
    await oldToken();
    const seen: Statement[] = [];
    const spy: SqlExecutor = {
      driver: executor.driver,
      all: (s) => {
        seen.push(s);
        return executor.all(s);
      },
      batch: (ss) => {
        seen.push(...ss);
        return executor.batch(ss);
      },
    };
    expect((await rotate({}, createTokenRepository(spy))).status).toBe('rotated');
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.params.length).toBeLessThanOrEqual(100);
  });
});

async function organizationRotation() {
  await oldToken(null);
  const now = iso(0);
  const repository = createTokenRepository(executor);
  const service = createServiceTokenService({
    tokens: repository,
    principals: {
      get: async () => ({
        id: SP_WIDE,
        name: 'wide',
        projectId: null,
        createdByUserId: OTHER_USER,
        status: 'active',
        revision: 1,
        permissions: ['project:read'],
      }),
    },
    authority: { livePermissions: async () => new Set(ISSUER_PERMISSIONS) },
    sessions: { isReauthFresh: () => true },
    organizations: {
      get: async () => ({
        id: a.orgId,
        slug: 'a',
        name: 'A',
        createdAt: now,
        updatedAt: now,
        settings: {
          retentionRemovedUpstreamDays: 30,
          tokenDefaultExpiryDays: 30,
          tokenCiReadonlyExpiryDays: 365,
        },
      }),
    },
    providers: { anchors: async () => ANCHORS },
    clock: fixedClock(now),
    ids: { ulid },
    log: () => {},
    keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
  });
  const auth = {
    session: { id: SESSION, userId: USER },
    principal: { kind: 'user', id: USER },
  } as AuthenticatedSession;
  const result = await service.rotate(
    a,
    auth,
    { kind: 'organization', userId: USER, permissions: new Set(), isOrganizationAdmin: true },
    fence(),
    { tokenId: TOKEN, routeProjectId: null, overlapDays: 7 },
  );
  expect(result.ok).toBe(true);
  expect(await rows('token')).toHaveLength(2);
  expect((await rows('token')).find((row) => row['id'] !== TOKEN)).toMatchObject({
    created_by_user_id: USER,
    project_id: null,
  });
}
it(
  'rotates an organization-level token on the organization route on node:sqlite',
  organizationRotation,
);
it('rotates an organization-level token on the organization route on Miniflare D1', async () => {
  await close();
  const require = createRequire(
    new URL('../../../runtime-cloudflare/package.json', import.meta.url),
  );
  const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['ROTATE'],
    }),
  );
  close = () => mf.dispose();
  const module = '@package-broker/runtime-cloudflare/db/d1-executor';
  const { createD1Executor } = await import(module);
  executor = createD1Executor(await mf.getD1Database('ROTATE'));
  await migrate(executor, await discoveredMigrations(), { holder: 'rotation-test' });
  ({ a, b } = await seedTwoOrganizations(executor));
  await seed();
  await organizationRotation();
}, 120_000);
