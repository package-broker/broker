import type { OrgContext } from '../db/port.js';
import type { EffectiveAuditConfig } from './effective.js';
import type { AuditHeadV1 } from './plugin-api.js';

export interface AuditStatusSnapshot extends AuditHeadV1 {
  readonly mode: 'trail' | 'export' | 'none';
  readonly pendingMode: 'trail' | 'export' | 'none' | null;
  readonly capacity: {
    readonly state: 'ok' | 'warning' | 'refusing';
    readonly journalRows: number;
    readonly journalBytes: number;
  };
  readonly restorePending: boolean;
  readonly sinks: readonly {
    readonly id: string;
    readonly state: 'active' | 'inactive' | 'blocked' | 'disabled' | 'retired';
    readonly progressSeq: number;
    readonly custodySeq: number;
    readonly durableAck: boolean;
    readonly activationSource: string;
  }[];
  readonly ledger: readonly { readonly kind: string; readonly count: number }[];
}

export interface AuditStatusReader {
  read(ctx: OrgContext): Promise<AuditStatusSnapshot>;
}

export type EffectiveAuditReader = (ctx: OrgContext) => Promise<EffectiveAuditConfig>;
