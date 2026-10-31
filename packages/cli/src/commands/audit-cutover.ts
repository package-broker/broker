import { parseArgs } from 'node:util';
import { registerAuditExport } from '@package-broker/core/audit/cutover';
import { orgContext } from '@package-broker/core/db/port';
import { createAuditCutoverRepository } from '@package-broker/db-sqlite/repositories/audit-cutover';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { isLostResponse } from '../cloudflare/d1-http-executor.js';
import { openTarget, type AdminTarget } from './admin.js';
import { isUlid } from '@package-broker/core/ids';
import { AuditArtifactError, verifyAuditArtifact } from './audit-artifact.js';

export async function runAuditCutover(argv: readonly string[]): Promise<number> {
  let opened: ReturnType<typeof openTarget> = null;
  try {
    const { positionals, values } = parseArgs({
      args: [...argv],
      options: {
        register: { type: 'string' },
        'org-id': { type: 'string' },
        sqlite: { type: 'string' },
        cloudflare: { type: 'boolean' },
        'database-id': { type: 'string' },
        generation: { type: 'string' },
        'actor-type': { type: 'string' },
        'actor-id': { type: 'string' },
      },
    });
    if (
      positionals.length ||
      !values.register ||
      (values['org-id'] !== undefined && !isUlid(values['org-id'])) ||
      !values.generation ||
      !/^(0|[1-9][0-9]*)$/.test(values.generation) ||
      !Number.isSafeInteger(Number(values.generation)) ||
      (values['actor-type'] !== 'user' && values['actor-type'] !== 'service_principal') ||
      !values['actor-id']
    )
      throw new TypeError();
    let target: AdminTarget;
    if (values.sqlite && !values.cloudflare && values['database-id'] === undefined)
      target = { kind: 'sqlite', file: values.sqlite };
    else if (!values.sqlite && values.cloudflare && values['database-id'])
      target = { kind: 'cloudflare', databaseId: values['database-id'], env: process.env };
    else throw new TypeError();
    const artifact = await verifyAuditArtifact(values.register);
    if (artifact.withheld > 0) throw new AuditArtifactError('withheld_present');
    if (values['org-id'] !== undefined && artifact.orgId !== values['org-id'])
      throw new AuditArtifactError('org_mismatch');
    opened = openTarget('audit cutover', target);
    if (!opened) return 2;
    const org = await createOrganizationBootstrap(opened.executor).findSingleton();
    if (!org) {
      console.error('audit cutover: organization_unavailable');
      return 5;
    }
    if (org.id !== artifact.orgId) throw new AuditArtifactError('org_mismatch');
    const repository = createAuditCutoverRepository(opened.executor);
    const applied = await registerAuditExport(
      repository,
      orgContext(org.id),
      artifact,
      Number(values.generation),
      { type: values['actor-type'], id: values['actor-id'] },
      new Date().toISOString(),
    );
    if (!applied)
      throw new AuditArtifactError(
        await repository.diagnose(orgContext(org.id), Number(values.generation), {
          type: values['actor-type'],
          id: values['actor-id'],
        }),
      );
    console.log(JSON.stringify({ result: 'applied' }));
    return 0;
  } catch (error) {
    if (isLostResponse(error)) {
      console.error('audit cutover: outcome_unknown; inspect the ledger before retrying');
      return 7;
    }
    console.error(
      error instanceof AuditArtifactError
        ? `audit cutover: ${error.code}`
        : error instanceof TypeError
          ? 'audit cutover: invalid_input'
          : 'audit cutover: operation_refused',
    );
    return error instanceof TypeError ? 2 : 1;
  } finally {
    await opened?.close();
  }
}
