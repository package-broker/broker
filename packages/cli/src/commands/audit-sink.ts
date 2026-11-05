import { parseArgs } from 'node:util';
import {
  administerAuditSink,
  AuditSinkAdminError,
  type AuditSinkAdminCommand,
} from '@package-broker/core/audit/sink-admin';
import { AuditForkLimitError, type AuditForkReason } from '@package-broker/core/audit/fork';
import { AUDIT_EVENTS, KERNEL_REASON_CODES } from '@package-broker/core/kernel/obs-codes';
import { createObservability } from '@package-broker/core/platform/observability';
import { orgContext } from '@package-broker/core/db/port';
import { createAuditForkRepository } from '@package-broker/db-sqlite/repositories/audit-fork';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { isLostResponse } from '../cloudflare/d1-http-executor.js';
import { openTarget, type AdminTarget } from './admin.js';

const alertCodes: Readonly<Record<AuditForkReason, string>> = {
  restore_detected: 'audit.restore_detected',
  local_fork: 'audit.local_fork',
  receiver_fork: 'audit.receiver_fork',
  history_limit: 'audit.history_limit',
  batch_limit: 'audit.batch_limit',
};

const observability = createObservability(
  { emit: (record) => console.error(JSON.stringify(record)) },
  { deploymentId: 'cli', runtime: 'node', requestId: null },
  {
    events: AUDIT_EVENTS,
    reasonCodes: KERNEL_REASON_CODES,
    routeTemplates: new Set(),
  },
);

const common = ['sqlite', 'cloudflare', 'database-id', 'generation', 'actor-type', 'actor-id'];
const flags: Readonly<Record<string, readonly string[]>> = {
  list: [],
  rebind: ['from'],
  replay: ['from'],
  retire: ['confirm'],
  unblock: [],
  skip: ['seq'],
  'confirm-restore': ['from'],
  resolve: ['ledger-id'],
  set: [],
};
const number = (value: string | undefined): number =>
  value !== undefined && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : NaN;

export async function runAuditSink(argv: readonly string[]): Promise<number> {
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
        from: { type: 'string' },
        seq: { type: 'string' },
        confirm: { type: 'string' },
        'ledger-id': { type: 'string' },
      },
    });
    const [group, operation, id] = positionals;
    if (
      !operation ||
      !flags[operation] ||
      Object.keys(values).some((flag) => ![...common, ...flags[operation]!].includes(flag)) ||
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
    let command: AuditSinkAdminCommand;
    if (
      group === 'policy' &&
      operation === 'set' &&
      positionals.length === 3 &&
      (id === 'required' || id === 'availability')
    )
      command = { operation: 'policy_set', policy: id };
    else if (group !== 'sink') throw new TypeError();
    else if (operation === 'list' && positionals.length === 2) command = { operation: 'list' };
    else if (
      operation === 'confirm-restore' &&
      positionals.length === 2 &&
      number(values.from) >= 1
    )
      command = { operation: 'confirm_restore', fromSeq: number(values.from) };
    else if (id && positionals.length === 3) {
      if ((operation === 'rebind' || operation === 'replay') && number(values.from) >= 1)
        command = { operation, sinkId: id, fromSeq: number(values.from) };
      else if (operation === 'retire' && values.confirm)
        command = { operation, sinkId: id, confirm: values.confirm };
      else if (operation === 'unblock') command = { operation, sinkId: id };
      else if (operation === 'skip' && number(values.seq) >= 1)
        command = { operation, sinkId: id, seq: number(values.seq) };
      else if (operation === 'resolve' && values['ledger-id'])
        command = { operation, sinkId: id, ledgerId: values['ledger-id'] };
      else throw new TypeError();
    } else throw new TypeError();
    opened = openTarget('audit sink', target);
    if (!opened) return 2;
    const organization = await createOrganizationBootstrap(opened.executor).findSingleton();
    if (!organization) {
      console.error('audit sink: organization_unavailable');
      return 5;
    }
    const result = await administerAuditSink(
      createAuditForkRepository(opened.executor),
      orgContext(organization.id),
      command,
      {
        alert: (reason) =>
          observability.log({
            level: 'error',
            event: 'audit.sink_admin_refused',
            reason_code: alertCodes[reason],
          }),
        generation: number(values.generation),
        now: new Date(),
        actor: { type: values['actor-type'], id: values['actor-id'] },
      },
    );
    console.log(JSON.stringify(result));
    return result.result === 'applied' ? 0 : 6;
  } catch (error) {
    if (isLostResponse(error)) {
      console.error('audit sink: outcome_unknown; inspect the ledger before retrying');
      return 7;
    }
    if (error instanceof AuditSinkAdminError || error instanceof AuditForkLimitError) {
      console.error(`audit sink: ${error.reason}`);
      return 1;
    }
    console.error(
      error instanceof TypeError ? 'audit sink: invalid_input' : 'audit sink: operation_refused',
    );
    return error instanceof TypeError ? 2 : 1;
  } finally {
    await opened?.close();
  }
}
