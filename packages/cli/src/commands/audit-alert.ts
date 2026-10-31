import { parseArgs } from 'node:util';
import {
  AUDIT_ALERT_CODES,
  AuditHealthConflictError,
  type AuditAlertCode,
} from '@package-broker/core/audit/health';
import { isUlid } from '@package-broker/core/ids';
import { orgContext } from '@package-broker/core/db/port';
import {
  type AuditAlertOperator,
  createAuditHealthRepository,
} from '@package-broker/db-sqlite/repositories/audit-health';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { isLostResponse } from '../cloudflare/d1-http-executor.js';
import { openTarget, type AdminTarget } from './admin.js';

const meanings: Readonly<Record<AuditAlertCode, string>> = {
  'audit.skipped': 'Audit records were skipped.',
  'audit.uncertain': 'Audit delivery has an uncertain outcome.',
  'audit.gap': 'Audit history contains a gap.',
  'audit.withheld': 'Audit records were withheld from delivery.',
  'audit.marker_rejected': 'An audit receiver rejected a marker.',
  'audit.blocked': 'An audit sink is blocked.',
  'audit.fork': 'Audit history requires fork or restore resolution.',
  'audit.pending_old': 'Pending audit records are older than five minutes.',
  'audit.capacity': 'Audit storage reached a capacity threshold.',
  'audit.mode_change': 'The audit mode changed.',
  'audit.policy_change': 'The audit retention policy changed.',
  'audit.sink_inactive': 'An audit sink is inactive.',
  'audit.config_invalid': 'Audit configuration is invalid.',
  'audit.mode_none': 'Audit recording is disabled.',
  'audit.chain_integrity': 'Audit chain integrity verification failed.',
  'audit.hold_failed': 'An audit retention hold failed.',
  'audit.prune_anchor': 'An audit pruning anchor could not be verified.',
};
const number = (value: string | undefined): number =>
  value !== undefined && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : NaN;

export async function runAuditAlert(argv: readonly string[]): Promise<number> {
  let opened: ReturnType<typeof openTarget> = null;
  try {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        sqlite: { type: 'string' },
        cloudflare: { type: 'boolean' },
        'database-id': { type: 'string' },
        generation: { type: 'string' },
        'actor-type': { type: 'string' },
        'actor-id': { type: 'string' },
        revision: { type: 'string' },
      },
    });
    const [operation, code] = positionals;
    if (
      (operation !== 'list' && operation !== 'ack') ||
      (operation === 'list' && (positionals.length !== 1 || values.revision !== undefined)) ||
      (operation === 'ack' &&
        (positionals.length !== 2 ||
          !AUDIT_ALERT_CODES.includes(code as AuditAlertCode) ||
          !Number.isSafeInteger(number(values.revision)))) ||
      (values['actor-type'] !== 'user' && values['actor-type'] !== 'service_principal') ||
      !values['actor-id'] ||
      !Number.isSafeInteger(number(values.generation))
    )
      throw new TypeError();
    let target: AdminTarget;
    if (values.sqlite && !values.cloudflare && values['database-id'] === undefined)
      target = { kind: 'sqlite', file: values.sqlite };
    else if (!values.sqlite && values.cloudflare && values['database-id'])
      target = { kind: 'cloudflare', databaseId: values['database-id'], env: process.env };
    else throw new TypeError();
    const operator: AuditAlertOperator = {
      actor: { type: values['actor-type'], id: values['actor-id'] },
      generation: number(values.generation),
      now: new Date(),
    };
    if (
      !isUlid(values['actor-id']) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(values['actor-id'])
    )
      throw new TypeError();
    opened = openTarget('audit alert', target);
    if (!opened) return 2;
    const organization = await createOrganizationBootstrap(opened.executor).findSingleton();
    if (!organization) {
      console.error('audit alert: organization_unavailable');
      return 5;
    }
    const org = orgContext(organization.id);
    const port = createAuditHealthRepository(opened.executor, operator);
    const status = await port.operatorStatus(org);
    if (status === 'stale') {
      console.log(JSON.stringify({ result: 'stale' }));
      return 6;
    }
    if (status !== 'ready') {
      console.error(`audit alert: ${status}`);
      return 1;
    }
    if (operation === 'list') {
      const snapshot = await port.snapshot(org);
      const alerts = AUDIT_ALERT_CODES.map((alertCode) => {
        const rows = (snapshot.alerts ?? []).filter((row) => row.code === alertCode);
        const revision = Math.max(0, ...rows.map((row) => row.revision));
        return {
          code: alertCode,
          meaning: meanings[alertCode],
          active: rows.some((row) => row.active),
          revision,
          acknowledgedRevision: Math.max(0, ...rows.map((row) => row.acknowledgedRevision)),
        };
      });
      console.log(JSON.stringify({ result: 'applied', alerts }));
      return 0;
    }
    if (!(await port.acknowledge(org, code as AuditAlertCode, number(values.revision)))) {
      console.error('audit alert: stale_revision');
      return 1;
    }
    console.log(JSON.stringify({ result: 'applied' }));
    return 0;
  } catch (error) {
    if (error instanceof AuditHealthConflictError) {
      console.log(JSON.stringify({ result: 'contended' }));
      return 6;
    }
    if (isLostResponse(error)) {
      console.error('audit alert: outcome_unknown; inspect alert state before retrying');
      return 7;
    }
    console.error(
      error instanceof TypeError ? 'audit alert: invalid_input' : 'audit alert: operation_refused',
    );
    return error instanceof TypeError ? 2 : 1;
  } finally {
    await opened?.close();
  }
}
