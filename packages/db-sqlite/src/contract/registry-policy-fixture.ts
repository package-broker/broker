import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { tokenMutationFence, type AuthenticatedTokenActor } from '@package-broker/core/authz/fence';
import { ulid } from '@package-broker/core/ids';
import type {
  PolicyAuditEnvelope,
  PolicyRuleCreate,
} from '@package-broker/core/db/registry-policy';
import { accessFixture } from './package-access-requests-fixture.js';
import type { CaseContext, Seed } from '../testing/mutation-table/harness.js';

export const POLICY_NOW = '2026-11-01T00:00:00.000Z';

export interface SeededRule {
  readonly id: string;
  readonly orgId: string;
  readonly projectId?: string | null;
  readonly ecosystem?: 'npm' | 'composer';
  readonly packageKey?: string | null;
  readonly kind?: 'min_age' | 'block' | 'allowlist' | 'quarantine' | 'client_floor';
  readonly minAgeSeconds?: number | null;
  readonly reasonCode?: string;
  readonly disabled?: boolean;
  readonly expiresAt?: string | null;
  readonly revision?: number;
  readonly clientFamily?: string | null;
  readonly clientMinVersion?: string | null;
}

/** Seeds a rule row directly; `seed.forged` bypasses foreign keys for adversarial rows. */
export async function seedRule(seed: Seed, rule: SeededRule): Promise<void> {
  const kind = rule.kind ?? 'block';
  await seed(
    `INSERT INTO registry_policy_rule (id, org_id, project_id, ecosystem, package_key, kind, min_age_seconds,
       client_family, client_min_version, reason_code, expires_at, disabled_at, disabled_reason, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rule.id,
    rule.orgId,
    rule.projectId ?? null,
    rule.ecosystem ?? 'npm',
    rule.packageKey === undefined
      ? kind === 'min_age' || kind === 'client_floor'
        ? null
        : 'left-pad'
      : rule.packageKey,
    kind,
    kind === 'min_age' ? (rule.minAgeSeconds ?? 86400) : null,
    kind === 'client_floor' ? (rule.clientFamily ?? 'npm') : null,
    kind === 'client_floor' ? (rule.clientMinVersion ?? '9.0.0') : null,
    rule.reasonCode ?? (kind === 'quarantine' ? 'malware' : 'security_review'),
    rule.expiresAt ?? null,
    rule.disabled === true ? '2026-11-02T00:00:00.000Z' : null,
    rule.disabled === true ? 'false_positive' : null,
    rule.revision ?? 1,
    POLICY_NOW,
    POLICY_NOW,
  );
}

export async function seedMember(
  seed: Seed,
  orgId: string,
  ruleId: string,
  version: string,
): Promise<void> {
  await seed(
    'INSERT INTO registry_policy_version (org_id, rule_id, version_normalized) VALUES (?, ?, ?)',
    orgId,
    ruleId,
    version,
  );
}

export type PolicyFixture = Awaited<ReturnType<typeof policyFixture>>;

/** Two organizations, an organization manager (decider) and a project manager (requester). */
export async function policyFixture(executor: SqlExecutor, context?: CaseContext) {
  const f = await accessFixture(executor, context);
  await f.seed(
    "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-decider', 'org:settings:write')",
    f.org.orgId,
  );
  await f.seed(
    "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-requester', 'project:settings:write')",
    f.org.orgId,
  );
  const envelope = (): PolicyAuditEnvelope => ({
    id: ulid(),
    occurredAt: new Date().toISOString(),
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
  });
  const create = (overrides: Partial<PolicyRuleCreate> = {}): PolicyRuleCreate => ({
    id: ulid(),
    scope: { kind: 'organization' },
    ecosystem: 'npm',
    packageKey: 'left-pad',
    kind: 'block',
    minAgeSeconds: null,
    clientFamily: null,
    clientMinVersion: null,
    denyUnknown: false,
    reasonCode: 'security_review',
    incidentId: null,
    expiresAt: null,
    members: [],
    now: new Date().toISOString(),
    audit: envelope(),
    ...overrides,
  });
  const tokenFence = () =>
    tokenMutationFence(
      {
        tokenId: 'token',
        tokenKind: 'pat',
        principalId: 'principal',
      } as unknown as AuthenticatedTokenActor,
      'org:packages:publish',
      {},
    );
  const reauth = (subject: { sessionId: string }, secondsAgo = 0) =>
    f.seed(
      "UPDATE session SET reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?",
      `-${secondsAgo} seconds`,
      subject.sessionId,
    );
  const count = async (table: string, orgId = f.org.orgId) =>
    (
      await executor.all<{ n: number }>({
        sql: `SELECT count(*) AS n FROM ${table} WHERE org_id = ?`,
        params: [orgId],
      })
    )[0]!.n;
  const epoch = async (orgId = f.org.orgId) =>
    (
      await executor.all<{ version: string }>({
        sql: 'SELECT version FROM cache_epoch WHERE org_id = ?',
        params: [orgId],
      })
    )[0]?.version;
  const rule = async (id: string) =>
    (
      await executor.all<Record<string, unknown>>({
        sql: 'SELECT * FROM registry_policy_rule WHERE id = ?',
        params: [id],
      })
    )[0];
  const members = async (id: string) =>
    (
      await executor.all<{ version_normalized: string }>({
        sql: 'SELECT version_normalized FROM registry_policy_version WHERE rule_id = ? ORDER BY version_normalized',
        params: [id],
      })
    ).map((row) => row.version_normalized);
  const audits = async () =>
    executor.all<{
      action: string;
      target_id: string;
      project_id: string | null;
      payload_json: string;
      actor_id: string;
    }>({
      sql: 'SELECT action, target_id, project_id, payload_json, actor_id FROM audit_pending WHERE org_id = ? ORDER BY id',
      params: [f.org.orgId],
    });
  /** Runs `before` once, right before the nth batch the wrapped executor sends. */
  const beforeBatch = (before: () => Promise<void>, nth = 1): SqlExecutor => {
    let seen = 0;
    return {
      driver: executor.driver,
      all: (statement: Statement) => executor.all(statement),
      async batch(statements) {
        seen += 1;
        if (seen === nth) await before();
        return executor.batch(statements);
      },
    } as SqlExecutor;
  };
  return {
    ...f,
    envelope,
    create,
    tokenFence,
    reauth,
    count,
    epoch,
    rule,
    members,
    audits,
    beforeBatch,
  };
}
