import type { DiscoveryRuleOptions } from '@package-broker/core/db/discovery-rules';
import type { SqlExecutor, OrgContext } from '@package-broker/core/db/port';
import { discoveryRuleFence } from '@package-broker/core/authz/fence';
import { ulid, systemClock } from '@package-broker/core/ids';
import { discoveryRuleAudit } from '@package-broker/core/runtime/discovery-rule-jobs';
import { seedBindings, seedSubject, fenceOf, ANCHORS } from './mutation-table/fixtures.js';
import type { CaseContext } from './mutation-table/harness.js';

export const RULE_ID = '01JA0000000000000000000011';
export const CREDENTIAL_ID = '01JA0000000000000000000012';
export const RULE_OPTIONS: DiscoveryRuleOptions = {
  name: 'Libraries',
  credentialId: CREDENTIAL_ID,
  installationId: 41,
  ecosystem: 'both',
  pattern: '*',
  includeForks: false,
  enabled: true,
  intervalSeconds: 86400,
};
export const ruleAudit = () =>
  discoveryRuleAudit({ ids: { ulid }, clock: systemClock }, RULE_ID, 'discovery_rule.run_started');
export const ruleFence = () =>
  discoveryRuleFence(RULE_ID, 1, CREDENTIAL_ID, 41, { id: 'DRJOB', owner: 'worker', fence: 3 });
export async function seedDiscoveryRule(
  executor: SqlExecutor,
  org: OrgContext,
  ruleId = RULE_ID,
  credentialId = CREDENTIAL_ID,
) {
  await executor.all({
    sql: "insert into credential(id,org_id,kind,ciphertext,nonce,key_version,aad) values(?,?,'github_app',x'00',zeroblob(12),1,'aad')",
    params: [credentialId, org.orgId],
  });
  await executor.all({
    sql: "insert into source_discovery_rule(org_id,id,name,credential_id,installation_id,ecosystem,repository_pattern,created_at,updated_at) values(?,?,?, ?,41,'both','*',?,?)",
    params: [
      org.orgId,
      ruleId,
      'Libraries',
      credentialId,
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  });
}
export async function seedDiscoveryLease(executor: SqlExecutor, org: OrgContext) {
  await executor.all({
    sql: "insert into job(id,org_id,type,payload_json,resource_key,state,lease_owner,lease_until,fence) values('DRJOB',?,'core:discovery-rule:v1',?,?,'running','worker','2999-01-01T00:00:00.000Z',3)",
    params: [
      org.orgId,
      JSON.stringify({ ruleId: RULE_ID, revision: 1 }),
      `discovery-rule:${RULE_ID}`,
    ],
  });
}
export async function seedDiscoveryAdministrator(context: CaseContext) {
  await seedBindings(context);
  const actor = await seedSubject(context, 'disc');
  await context.executor.all({
    sql: "update role_permission set permission='org:sources:write' where org_id=? and role_id='R-disc'",
    params: [context.orgs.a.orgId],
  });
  await context.executor.all({
    sql: "update session set reauth_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where org_id=? and id=?",
    params: [context.orgs.a.orgId, actor.sessionId],
  });
  return { fence: fenceOf(actor), anchors: ANCHORS, actor };
}
