/* eslint-disable no-restricted-syntax -- Isolated fixture seeding and full database snapshots require SQL; this module is rehearsal-only. */
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { createFixtureVersionListings } from '@package-broker/db-sqlite/testing/migrated-database';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { orgContext, type SqlExecutor, type SqlValue } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { BlobStore, Sha256 } from '@package-broker/core/platform/blob';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createCatalogueWriteGuard } from '@package-broker/db-sqlite/repositories/catalogue-write-package';
import { createCatalogueWriter } from '@package-broker/db-sqlite/repositories/catalogue-writer';
import { createSessionService } from '@package-broker/core/auth/session';
import { createPersonalTokenService } from '@package-broker/core/authz/pat-service';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { readMasterKeys } from '@package-broker/core/secrets/master-key';
import { createSessionRepository } from '@package-broker/db-sqlite/repositories/session';
import { createTokenRepository } from '@package-broker/db-sqlite/repositories/token';
import { createOrganizationRepository } from '@package-broker/db-sqlite/repositories/organization';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';

export const ORIGIN = 'https://restore.test';
const EMAIL = 'rehearsal@example.test';
const PASSWORD = 'isolated restore rehearsal password 42';
export const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export type Requester = (request: Request) => Promise<Response>;
export interface SeededDeployment {
  orgId: string;
  foreignOrgId: string;
  bytes: Uint8Array;
  sha256: string;
  distPath: string;
  foreignDistPath: string;
  token: string;
  totp: Uint8Array;
}

export function archive(): Uint8Array {
  const body = Buffer.from('{"name":"restore-fixture","version":"1.0.0"}\n');
  const header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Uint8Array.from(
    gzipSync(Buffer.concat([header, body, Buffer.alloc(512 - body.length + 1024)])),
  );
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function setupFixtureIdentity(fetch: Requester, setup: string) {
  const previous = systemClock.now;
  const instant = Date.now();
  systemClock.now = () => new Date(instant);
  try {
    const started = await fetch(post('/_pb/auth/local/setup/start', { token: setup }));
    if (started.status !== 200) throw new Error('fixture setup start refused');
    const { secret } = (await started.json()) as { secret: string };
    const totp = base32Decode(secret);
    const step = Math.floor(instant / 30000);
    const finished = await fetch(
      post('/_pb/auth/local/setup/finish', {
        token: setup,
        password: PASSWORD,
        code: await totpCode(totp, step - 1),
      }),
    );
    if (finished.status !== 204) throw new Error('fixture setup finish refused');
    const cookie = finished.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1];
    if (csrf === undefined) throw new Error('fixture CSRF missing');
    const reauth = await fetch(
      post(
        '/_pb/auth/local/reauth',
        { password: PASSWORD, code: await totpCode(totp, step) },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    if (reauth.status !== 204) throw new Error('fixture reauthentication refused');
    return { totp, cookie, csrf };
  } finally {
    systemClock.now = previous;
  }
}

export async function seedRecords(
  executor: SqlExecutor,
  blob: BlobStore,
  fetch: Requester,
  masterKey: string,
): Promise<SeededDeployment> {
  const organizations = await seedTwoOrganizations(executor);
  const orgId = organizations.a.orgId;
  const foreignOrgId = organizations.b.orgId;
  const bytes = archive();
  const sha256 = digest(bytes);
  const paths: string[] = [];
  for (const [org, slug] of [
    [orgId, 'rehearsal'],
    [foreignOrgId, 'foreign'],
  ] as const) {
    const ctx = orgContext(org);
    const projectId = ulid();
    const sourceId = ulid();
    const jobId = ulid();
    const sql = (sql: string, params: SqlValue[]) => executor.batch([{ sql, params }]);
    await sql('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
      projectId,
      org,
      slug === 'foreign' ? 'foreign' : 'alpha',
      'Rehearsal',
    ]);
    if (org === orgId)
      await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'beta', 'Excluded')", [
        ulid(),
        org,
      ]);
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'offline', 'npm', 'npm_registry')",
      [sourceId, org],
    );
    await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
      org,
      projectId,
      sourceId,
    ]);
    await sql(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES (?, ?, 'rehearsal', ?, 'running', 'rehearsal', '2999-01-01T00:00:00.000Z', 1)",
      [jobId, org, jobId],
    );
    const writer = createCatalogueWriter(executor);
    const guard = createCatalogueWriteGuard(ctx, { id: jobId, owner: 'rehearsal', fence: 1 });
    const synced = await writer.syncPackage(ctx, guard, {
      sourceId,
      ecosystem: 'npm',
      key: 'restore-fixture',
      description: null,
      versions: [
        {
          version: '1.0.0',
          versionNormalized: '1.0.0',
          license: null,
          distType: 'tgz',
          sourceRef: null,
          upstreamReleasedAt: null,
          metadata: normalizeVersionMetadata('npm', { name: 'restore-fixture', version: '1.0.0' }),
          history: { basis: 'import_time', noOtherDate: true, at: '2026-01-01T00:00:00.000Z' },
        },
      ],
    });
    if (synced.inserted !== 1) throw new Error('fixture catalogue seed refused');
    const [version] = await executor.all<{ id: string; revision: number }>({
      sql: 'SELECT id, revision FROM version WHERE org_id = ? AND package_id = ?',
      params: [org, synced.packageId],
    });
    if (version === undefined) throw new Error('fixture version missing');
    await blob.put(ctx, sha256 as Sha256, new Response(bytes).body!, {
      size: bytes.length,
      mediaType: 'application/octet-stream',
      refetchable: false,
    });
    const attached = await writer.attachDist(ctx, guard, {
      versionId: version.id,
      revision: version.revision,
      sha256: sha256 as Sha256,
    });
    if (!attached.changed) throw new Error('fixture attachment refused');
    const scope = { kind: 'package' as const, packageId: synced.packageId };
    const { stamp } = await writer.openListing(ctx, guard, scope);
    await writer.markListing(ctx, guard, { scope, stamp, present: ['1.0.0'] });
    await writer.finalizeListing(
      ctx,
      guard,
      await createFixtureVersionListings(executor).complete(ctx, synced.packageId, stamp),
      { attemptedCandidates: 1, successfulCandidates: 1, definitiveAbsent: 0 },
    );
    await sql(
      "UPDATE job SET state = 'succeeded', lease_owner = NULL, lease_until = NULL WHERE org_id = ? AND id = ?",
      [org, jobId],
    );
    paths.push(
      `/${org === orgId ? 'alpha' : 'foreign'}/npm/restore-fixture/-/restore-fixture-1.0.0.tgz`,
    );
  }
  const setup = randomBytes(32).toString('base64url');
  await bootstrapAdmin(executor, orgContext(orgId), {
    email: EMAIL,
    userId: ulid(),
    setupHash: digest(Buffer.from(setup)),
    setupExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    grantId: ulid(),
    roleIds: Object.fromEntries(DEFAULT_ROLES.map(({ key }) => [key, ulid()])) as Record<
      DefaultRoleKey,
      string
    >,
    opId: ulid(),
    now: new Date().toISOString(),
  });
  const { totp, cookie, csrf } = await setupFixtureIdentity(fetch, setup);
  const [project] = await executor.all<{ id: string }>({
    sql: "SELECT id FROM project WHERE org_id = ? AND slug = 'alpha'",
    params: [orgId],
  });
  const ctx = orgContext(orgId);
  const sessions = createSessionService({
    sessions: createSessionRepository(executor),
    clock: systemClock,
    publicOrigin: ORIGIN,
  });
  const request = post('/_pb/me/tokens', {}, { cookie, 'x-csrf-token': csrf });
  const authenticated = await sessions.authenticate(ctx, request);
  if (authenticated === null) throw new Error('fixture issuing session refused');
  await sessions.assertCsrf(request, authenticated);
  const tokens = createPersonalTokenService({
    tokens: createTokenRepository(executor),
    sessions,
    organizations: createOrganizationRepository(executor),
    providers: { anchors: async () => [] },
    keyring: createKeyring(readMasterKeys({ current: masterKey })),
    clock: systemClock,
    ids: { ulid },
    log: () => undefined,
  });
  const fence = mutationFence(
    {
      userId: authenticated.session.userId,
      sessionId: authenticated.session.id,
    } as AuthenticatedActor,
    {},
  );
  const issued = await tokens.issue(
    ctx,
    authenticated,
    fence,
    {
      name: 'Restore rehearsal',
      scope: 'read',
      projectMode: 'selected',
      projectIds: [project!.id],
    },
    { audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null } },
  );
  if (!issued.ok) throw new Error(`fixture PAT refused: ${issued.error}`);
  const token = issued.value.plaintext;
  return {
    orgId,
    foreignOrgId,
    bytes,
    sha256,
    distPath: paths[0]!,
    foreignDistPath: paths[1]!,
    token,
    totp,
  };
}

export async function verifyRoutes(fetch: Requester, seeded: SeededDeployment) {
  const login = await fetch(
    post('/_pb/auth/local/login', {
      email: EMAIL,
      password: PASSWORD,
      code: await totpCode(seeded.totp, Math.floor(Date.now() / 30000) + 1),
    }),
  );
  const get = (path: string, token = seeded.token) =>
    fetch(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } }));
  const allowed = await get('/alpha/packages.json');
  const excluded = await get('/beta/packages.json');
  const foreign = await get(seeded.foreignDistPath);
  const unauthenticated = await fetch(new Request(`${ORIGIN}${seeded.distPath}`));
  const response = await get(seeded.distPath);
  let bytes = new Uint8Array();
  let completeBody = false;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
    completeBody =
      response.status === 200 &&
      bytes.length === seeded.bytes.length &&
      digest(bytes) === seeded.sha256;
  } catch {
    /* A broken stream is a failed download. */
  }
  return {
    checks: {
      signIn: login.status === 204,
      tokenAuthenticates: allowed.status === 200,
      tokenScopeApplies:
        [401, 403, 404].includes(excluded.status) && [401, 403, 404].includes(foreign.status),
      downloadMatches: completeBody,
    },
    downloadSha256: digest(bytes),
    download: { status: response.status, completeBody },
    foreignStatus: foreign.status,
    unauthenticatedStatus: unauthenticated.status,
  };
}

export const failedChecks = () => ({
  signIn: false,
  tokenAuthenticates: false,
  tokenScopeApplies: false,
  downloadMatches: false,
});
