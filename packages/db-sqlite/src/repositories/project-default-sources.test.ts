import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import {
  createAuthorizationEngine,
  engineGrantOf,
  patValidationGate,
} from '@package-broker/core/authz/engine';
import { authorizeRoute, type AuthorizationRequest } from '@package-broker/core/kernel/authorize';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createAccessRepository } from './access.js';
import { auditEvent, type AuditAction } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { DefaultRoleKey } from '@package-broker/core/authz/permissions';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createProjectRepository, type ProjectRepository } from './project.js';
import { seedDefaultsStatements } from './role.js';

const NOW = '2026-10-15T12:00:00.000Z';

function uid(tag: string): string {
  return `01J${'0'.repeat(23 - tag.length)}${tag}`;
}

const USER = uid('U1');
const SESSION = uid('S1');
const NEW_PROJECT = uid('PN');
const OLD_PROJECT = uid('P0');
const OTHER_PROJECT = uid('PX');
const FOREIGN_PROJECT = uid('PF');
const S_VCS = uid('SV');
const S_PROXY = uid('SP');
const S_OWNED = uid('SW');
const S_FOREIGN = uid('SF');
const NO_CREATE_ROLE = uid('R2');
const ROLES: Record<DefaultRoleKey, string> = {
  organization_admin: uid('RA'),
  organization_auditor: uid('RU'),
  project_owner: uid('R0'),
  project_developer: uid('RD'),
  project_auditor: uid('RX'),
};
const FOREIGN_ROLES: Record<DefaultRoleKey, string> = {
  organization_admin: uid('QA'),
  organization_auditor: uid('QU'),
  project_owner: uid('QO'),
  project_developer: uid('QD'),
  project_auditor: uid('QX'),
};

let database: MigratedDatabase;
let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;
let projects: ProjectRepository;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function rows<T>(sql: string, ...params: Statement['params']): Promise<T[]> {
  return executor.all<T>(stmt(sql, ...params));
}

function fence(userId = USER, sessionId = SESSION): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

function create(id = NEW_PROJECT, slug = 'fresh') {
  return projects.create(a, fence(), {
    audit: mutationAudit('project.create', id, id),
    id,
    slug,
    name: slug,
    now: NOW,
  });
}

async function visible(projectId: string): Promise<string[]> {
  return (
    await rows<{ name: string }>(
      `SELECT p.name FROM project_package pp JOIN package p ON p.id = pp.package_id
       WHERE pp.project_id = ? ORDER BY p.name`,
      projectId,
    )
  ).map((row) => row.name);
}

async function attachments(projectId: string): Promise<Record<string, number>> {
  return Object.fromEntries(
    (
      await rows<{ source_id: string; precedence: number }>(
        'SELECT source_id, precedence FROM project_source WHERE project_id = ?',
        projectId,
      )
    ).map((row) => [row.source_id, row.precedence]),
  );
}

async function counts(): Promise<[number, number]> {
  const [sources] = await rows<{ n: number }>('SELECT count(*) AS n FROM project_source');
  const [derived] = await rows<{ n: number }>('SELECT count(*) AS n FROM project_package');
  return [sources?.n ?? -1, derived?.n ?? -1];
}

function source(id: string, orgId: string, projectId: string | null, type: string, name: string) {
  return stmt(
    `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, default_visible_to_new_projects, removal_policy)
     VALUES (?, ?, ?, ?, 'composer', ?, 1, 'flag')`,
    id,
    orgId,
    projectId,
    name,
    type,
  );
}

function pkg(
  id: string,
  orgId: string,
  sourceId: string,
  name: string,
  flag: 0 | 1,
  ecosystem = 'composer',
) {
  return stmt(
    `INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    id,
    orgId,
    sourceId,
    ecosystem,
    name,
    flag,
  );
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  projects = createProjectRepository(executor);
  await executor.batch([
    ...seedDefaultsStatements(a, { now: NOW, ids: ROLES }),
    ...seedDefaultsStatements(b, { now: NOW, ids: FOREIGN_ROLES }),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'without_create', 'Without create', 'organization', 1)",
      NO_CREATE_ROLE,
      a.orgId,
    ),
    stmt(
      'INSERT INTO role_permission (org_id, role_id, permission) SELECT org_id, ?, permission FROM role_permission WHERE org_id = ? AND role_id = ?',
      NO_CREATE_ROLE,
      a.orgId,
      ROLES.project_owner,
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      USER,
      a.orgId,
      'u@example.test',
    ),
    stmt(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
      uid('C1'),
      a.orgId,
    ),
    stmt(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, 'pbkdf2-sha256$test', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours'))",
      USER,
      a.orgId,
      uid('C1'),
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', 'u@example.test', 'organization', ?)",
      uid('G1'),
      a.orgId,
      ROLES.organization_admin,
    ),
    stmt(
      `INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, NULL, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '3600 seconds'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'))`,
      SESSION,
      a.orgId,
      USER,
      'a'.repeat(64),
      'b'.repeat(64),
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      OLD_PROJECT,
      a.orgId,
      'old',
      'Old',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      OTHER_PROJECT,
      a.orgId,
      'other',
      'Other',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      FOREIGN_PROJECT,
      b.orgId,
      'foreign',
      'Foreign',
    ),
    source(S_VCS, a.orgId, null, 'vcs', 'org-vcs'),
    source(S_PROXY, a.orgId, null, 'packagist_proxy', 'org-proxy'),
    source(S_OWNED, a.orgId, OTHER_PROJECT, 'vcs', 'project-owned'),
    source(S_FOREIGN, b.orgId, null, 'vcs', 'foreign-vcs'),
    pkg(uid('K1'), a.orgId, S_VCS, 'acme/shown', 1),
    pkg(uid('K2'), a.orgId, S_VCS, 'acme/hidden', 0),
    pkg(uid('K3'), a.orgId, S_PROXY, 'acme/proxied', 1),
    pkg(uid('K4'), a.orgId, S_PROXY, 'acme/proxied-hidden', 0),
    pkg(uid('K5'), a.orgId, S_OWNED, 'acme/owned', 1),
    pkg(uid('K6'), b.orgId, S_FOREIGN, 'acme/foreign', 1),
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('project creation attaches organization sources', () => {
  it('attaches every organization source with its default precedence and nothing else', async () => {
    expect(await create()).toBe('created');
    expect(await attachments(NEW_PROJECT)).toEqual({ [S_VCS]: 100, [S_PROXY]: 1000 });
  });

  it('derives exactly the flag-1 packages of organization sources', async () => {
    expect(await create()).toBe('created');
    expect(await visible(NEW_PROJECT)).toEqual(['acme/proxied', 'acme/shown']);
    const origins = await rows<{ origin: string }>(
      'SELECT DISTINCT origin FROM project_package WHERE project_id = ?',
      NEW_PROJECT,
    );
    expect(origins).toEqual([{ origin: 'subscription' }]);
  });

  it('leaves existing projects and their attachments untouched', async () => {
    expect(await create()).toBe('created');
    expect(await attachments(OLD_PROJECT)).toEqual({});
    expect(await visible(OLD_PROJECT)).toEqual([]);
    expect(await attachments(OTHER_PROJECT)).toEqual({});
  });

  it.each([
    ['duplicate slug', NEW_PROJECT, 'old'],
    ['duplicate id', OLD_PROJECT, 'other-slug'],
  ])('rolls back attachment and derivation rows for a %s', async (_label, id, slug) => {
    const before = await counts();
    expect(await create(id, slug)).toBe('duplicate');
    expect(await counts()).toEqual(before);
    expect(await attachments(id)).toEqual({});
    expect(await visible(id)).toEqual([]);
  });

  it.each([undefined, ROLES.project_owner])(
    'writes no source or package rows without authority with initialRoleId %s',
    async (initialRoleId) => {
      await executor.batch([
        stmt(
          'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          uid('U2'),
          a.orgId,
          'v@example.test',
        ),
        stmt(
          "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
          uid('C2'),
          a.orgId,
        ),
        stmt(
          "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, 'pbkdf2-sha256$test', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours'))",
          uid('U2'),
          a.orgId,
          uid('C2'),
        ),
        stmt(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', 'v@example.test', 'organization', ?)",
          uid('G2'),
          a.orgId,
          NO_CREATE_ROLE,
        ),
        stmt(
          `INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, NULL, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '3600 seconds'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'))`,
          uid('S2'),
          a.orgId,
          uid('U2'),
          'c'.repeat(64),
          'd'.repeat(64),
        ),
      ]);
      const before = await counts();
      const outcome = await projects.create(a, fence(uid('U2'), uid('S2')), {
        audit: mutationAudit('project.create', NEW_PROJECT, NEW_PROJECT),
        id: NEW_PROJECT,
        slug: 'fresh',
        name: 'fresh',
        now: NOW,
        ...(initialRoleId === undefined ? {} : { initialRoleId }),
      });
      expect(outcome).toBe('authority');
      expect(await counts()).toEqual(before);
      expect(await attachments(NEW_PROJECT)).toEqual({});
      expect(await visible(NEW_PROJECT)).toEqual([]);
      expect(await rows('SELECT id FROM project WHERE id = ?', NEW_PROJECT)).toEqual([]);
    },
  );

  it('writes no source or package rows when the initial role is not allowed', async () => {
    const before = await counts();
    const outcome = await projects.create(a, fence(), {
      audit: mutationAudit('project.create', NEW_PROJECT, NEW_PROJECT),
      id: NEW_PROJECT,
      slug: 'fresh',
      name: 'fresh',
      now: NOW,
      initialRoleId: ROLES.organization_admin,
    });
    expect(outcome).toBe('initial_role_not_allowed');
    expect(await counts()).toEqual(before);
  });

  it('creates in organization B using only B sources and packages', async () => {
    await executor.batch([
      stmt('UPDATE user_account SET org_id = ? WHERE id = ?', b.orgId, USER),
      stmt('UPDATE session SET org_id = ? WHERE id = ?', b.orgId, SESSION),
      stmt('UPDATE credential SET org_id = ? WHERE id = ?', b.orgId, uid('C1')),
      stmt('UPDATE local_login SET org_id = ? WHERE user_id = ?', b.orgId, USER),
      stmt(
        'UPDATE access_grant SET org_id = ?, role_id = ? WHERE id = ?',
        b.orgId,
        FOREIGN_ROLES.organization_admin,
        uid('G1'),
      ),
    ]);
    expect(
      await projects.create(b, fence(), {
        audit: mutationAudit('project.create', NEW_PROJECT, NEW_PROJECT),
        id: NEW_PROJECT,
        slug: 'fresh',
        name: 'Fresh',
        now: NOW,
      }),
    ).toBe('created');
    expect(await attachments(NEW_PROJECT)).toEqual({ [S_FOREIGN]: 100 });
    expect(await visible(NEW_PROJECT)).toEqual(['acme/foreign']);
  });

  it('attaches npm sources with npmjs_proxy precedence and derives only visible npm packages', async () => {
    const vcs = uid('NV');
    const proxy = uid('NP');
    await executor.batch([
      source(vcs, a.orgId, null, 'vcs', 'npm-vcs'),
      source(proxy, a.orgId, null, 'npmjs_proxy', 'npm-proxy'),
      stmt("UPDATE source SET ecosystem = 'npm' WHERE id IN (?, ?)", vcs, proxy),
      pkg(uid('N1'), a.orgId, vcs, '@acme/shown', 1, 'npm'),
      pkg(uid('N2'), a.orgId, vcs, '@acme/hidden', 0, 'npm'),
      pkg(uid('N3'), a.orgId, proxy, '@acme/proxied', 1, 'npm'),
    ]);
    expect(await create()).toBe('created');
    expect(await attachments(NEW_PROJECT)).toEqual({
      [S_VCS]: 100,
      [S_PROXY]: 1000,
      [vcs]: 100,
      [proxy]: 1000,
    });
    expect(await visible(NEW_PROJECT)).toEqual([
      '@acme/proxied',
      '@acme/shown',
      'acme/proxied',
      'acme/shown',
    ]);
  });

  it('creates successfully when the organization has no organization sources', async () => {
    await executor.batch([
      stmt('DELETE FROM package WHERE source_id IN (?, ?)', S_VCS, S_PROXY),
      stmt('DELETE FROM source WHERE id IN (?, ?)', S_VCS, S_PROXY),
    ]);
    expect(await create()).toBe('created');
    expect(await attachments(NEW_PROJECT)).toEqual({});
    expect(await visible(NEW_PROJECT)).toEqual([]);
  });

  it('rechecks the writer fence after a grant changes while an authorization hook awaits', async () => {
    const origin = 'https://broker.test';
    const secret = 'A'.repeat(43);
    const csrf = 'B'.repeat(43);
    await executor.batch([
      stmt(
        'UPDATE session SET secret_hash = ?, csrf_hash = ? WHERE id = ?',
        await sha256Hex(secret),
        await sha256Hex(csrf),
        SESSION,
      ),
    ]);
    const engine = createAuthorizationEngine({
      access: createAccessRepository(executor),
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
        nowMs: Date.now,
        dispatch: () => undefined,
        log: () => undefined,
      },
      patValidation: patValidationGate,
      publicOrigin: origin,
      providerAnchors: async () => [],
    });
    const request: AuthorizationRequest = {
      request: new Request(`${origin}/create`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE}=${secret}`,
          origin,
          'x-csrf-token': csrf,
        },
      }),
      org: a,
      params: {},
      route: {
        plugin: 'core',
        method: 'POST',
        path: '/create',
        permission: 'org:projects:create',
        boundary: 'organization',
      },
    };
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = authorizeRoute(
      request,
      engine,
      [
        {
          plugin: 'guard',
          handler: async () => {
            enter();
            await held;
          },
        },
      ],
      undefined,
      { hookTimeoutMs: 1000 },
    );
    await entered;
    const before = await counts();
    try {
      await executor.batch([
        stmt(
          'UPDATE access_grant SET role_id = ?, revision = revision + 1 WHERE org_id = ? AND id = ?',
          NO_CREATE_ROLE,
          a.orgId,
          uid('G1'),
        ),
      ]);
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ allow: true });
    const grant = engineGrantOf(request);
    expect(grant?.sessionId).toBe(SESSION);
    const writer = mutationFence(
      {
        userId: grant!.principal.id,
        sessionId: grant!.sessionId!,
      } as AuthenticatedActor,
      {},
    );
    expect(
      await projects.create(a, writer, {
        audit: mutationAudit('project.create', NEW_PROJECT, NEW_PROJECT),
        id: NEW_PROJECT,
        slug: 'fresh',
        name: 'Fresh',
        now: NOW,
        initialRoleId: ROLES.project_owner,
      }),
    ).toBe('authority');
    expect(await counts()).toEqual(before);
    expect(await attachments(NEW_PROJECT)).toEqual({});
    expect(await visible(NEW_PROJECT)).toEqual([]);
    expect(await rows('SELECT id FROM project WHERE id = ?', NEW_PROJECT)).toEqual([]);
  });

  it('attaches nothing of another organization', async () => {
    expect(await create()).toBe('created');
    expect(Object.keys(await attachments(NEW_PROJECT))).not.toContain(S_FOREIGN);
    expect(await attachments(FOREIGN_PROJECT)).toEqual({});
  });
});

function mutationAudit(action: AuditAction, targetId: string, projectId: string) {
  const id = ulid();
  const result = auditEvent({
    id,
    now: new Date().toISOString(),
    action,
    actor: { type: 'system', id: null },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
    target: { type: action.split('.')[0]!, id: targetId },
    projectId,
  });
  if (!result.ok) throw new Error('Invalid test audit event');
  return result.event;
}
