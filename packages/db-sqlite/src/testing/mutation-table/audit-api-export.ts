import { expect } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { createAuditApiExportStore } from '../../repositories/audit-api-export.js';
import { createAuditLedgerRepository } from '../../repositories/audit-ledger.js';
import {
  EXPORT_PROVIDERS,
  EXPORT_USER,
  exportFence,
  seedExportAdmin,
} from '../audit-api-export-suite.js';
import { orgOf, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

const mutated = (context: CaseContext) =>
  createAuditApiExportStore(
    {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    },
    EXPORT_PROVIDERS,
  );
const policy: ContractCase = {
  name: 'export policy is read from the requested organization',
  async run(context) {
    const { foreign } = orgOf(context);
    await context.executor.batch([
      {
        sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?",
        params: [foreign.orgId],
      },
    ]);
    expect((await mutated(context).snapshot(foreign)).policy).toBe('required');
  },
};
const range: ContractCase = {
  name: 'export dispositions exclude another organization on the same chain',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const plain = createAuditApiExportStore(context.executor);
    const snapshot = await plain.snapshot(own);
    const entry: AuditLedgerEntry = {
      id: ulid(),
      kind: 'uncertain',
      chainId: snapshot.head.chainId,
      epoch: snapshot.head.epoch,
      fromSeq: 1,
      toSeq: 1,
      count: 1,
      sinkId: null,
      reasonCode: 'partial_rejected',
      policy: 'availability',
      modeGeneration: 0,
      actorType: 'system',
      actorId: null,
      createdAt: new Date().toISOString(),
    };
    const ledger = createAuditLedgerRepository(context.executor);
    await ledger.append(own, [entry]);
    const foreignEntry = { ...entry, id: ulid() };
    await ledger.append(foreign, [foreignEntry]);
    expect(
      (await mutated(context).dispositions(foreign, snapshot, 1, 1)).map((row) => row.id),
    ).toEqual([foreignEntry.id]);
  },
};
const rate: ContractCase = {
  name: 'foreign export accesses do not consume this organization rate limit',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedExportAdmin(context.executor, own);
    const plain = createAuditApiExportStore(context.executor, EXPORT_PROVIDERS);
    const snapshot = await plain.snapshot(own);
    const now = new Date().toISOString();
    const entry: AuditLedgerEntry = {
      id: ulid(),
      kind: 'export',
      chainId: snapshot.head.chainId,
      epoch: snapshot.head.epoch,
      fromSeq: 1,
      toSeq: 1,
      count: 0,
      sinkId: null,
      reasonCode: 'api_export',
      policy: 'availability',
      modeGeneration: 0,
      actorType: 'user',
      actorId: EXPORT_USER,
      createdAt: now,
    };
    await createAuditLedgerRepository(context.executor).append(
      foreign,
      Array.from({ length: 10 }, () => ({ ...entry, id: ulid() })),
    );
    const event = auditEvent({
      id: ulid(),
      now,
      action: 'audit.export',
      actor: { type: 'user', id: EXPORT_USER },
      target: { type: 'organization', id: own.orgId },
      context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      changes: {
        count: { new: 0 },
        from_seq: { new: 1 },
        to_seq: { new: 1 },
        format: { new: 'api' },
      },
    });
    if (!event.ok) throw new Error('Invalid export fixture');
    expect(await mutated(context).record(own, exportFence(), snapshot, event.event, [entry])).toBe(
      'recorded',
    );
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditApiExportStore',
    file: 'repositories/audit-api-export.ts',
    cases: [policy, range, rate],
    predicates: [
      {
        name: 'export policy organization',
        locate: /(?<=modeGeneration FROM audit_chain WHERE )org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: policy.name,
      },
      {
        name: 'export disposition organization',
        locate: /(?<=FROM audit_ledger\s+WHERE )org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: range.name,
      },
      {
        name: 'export rate organization',
        locate: /(?<=count\(\*\) from audit_ledger where )org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: rate.name,
      },
    ],
    waivers: [
      {
        locate: /"[a-z_]+"\."org_id"\s*=\s*\(select "guard_values"/,
        reason:
          'Permission evidence delegates to the separately registered permissionRows builder and its bound organization CTE.',
      },
      {
        locate: /(?:open_gap|stored|hidden)\.org_id = \?/,
        reason:
          'Append statements delegate to the separately registered createAuditLedgerRepository.',
      },

      {
        locate: /(?<=FROM audit_chain WHERE )org_id = \?/,
        reason: 'Bound journal head delegates to createAuditJournalReader, registered separately.',
      },
      {
        locate: /(?<=FROM audit_pending WHERE )org_id = \?/,
        reason:
          'Bound journal pending count delegates to createAuditJournalReader, registered separately.',
      },
      {
        locate: /"[a-z_]+"\."org_id"\s*=\s*(?:\?|"[a-z_]+"\."org_id"|"[a-z_]+"\."org")/,
        reason:
          'Live session and permission evidence delegate to actorAuthority and permissionRows, registered separately.',
      },
      {
        locate: /(?<=from session where )org_id = \?/,
        reason:
          'The globally unique session id is also checked with org and user by actorAuthority in the same assertion.',
      },
      {
        locate: /(?<=from audit_chain where )org_id = \?/,
        reason:
          'Snapshot identity also pins the organization-specific chain id. Head organization isolation is tested through the registered bound reader.',
      },
      {
        locate: /(?<=stored\.org_id = )\?/,
        reason:
          'Ledger statement scoping delegates to createAuditLedgerRepository, registered separately.',
      },
    ],
  },
];
