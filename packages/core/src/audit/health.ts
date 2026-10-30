import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { AUDIT_ALERT_CODES, type Observability } from '../platform/observability.js';

export { AUDIT_ALERT_CODES };
export type AuditAlertCode = (typeof AUDIT_ALERT_CODES)[number];
export interface AuditHealthObservation {
  readonly code: AuditAlertCode;
  /** Stable for one incident; changing it records a new occurrence, including loss spikes. */
  readonly fingerprint: string;
  readonly origin?: 'ledger' | 'live';
  readonly failing: boolean;
  readonly active?: boolean;
}
export interface AuditHealthAlert {
  readonly code: AuditAlertCode;
  readonly revision: number;
  readonly acknowledgedRevision: number;
  readonly active: boolean;
  readonly failing: boolean;
}
export interface AuditHealthStoredAlert extends AuditHealthAlert {
  readonly fingerprint: string;
  readonly origin: 'ledger' | 'live' | 'source';
}
export interface AuditHealthSnapshot {
  readonly alerts?: readonly AuditHealthStoredAlert[];
  readonly mode: 'trail' | 'export' | 'none';
  readonly capacityState: 'ok' | 'warning' | 'refusing';
  readonly restorePending: boolean;
  readonly oldestPendingAt: string | null;
  readonly sinks: readonly {
    readonly id: string;
    readonly state: 'active' | 'inactive' | 'blocked' | 'disabled' | 'retired';
    readonly blockedReason: string | null;
  }[];
  readonly incidents: readonly AuditHealthObservation[];
}
export interface AuditHealthPort {
  /** Capture transient alerts at their source even if no monitor is polling. */
  raise(ctx: OrgContext, code: AuditAlertCode): Promise<void>;
  snapshot(ctx: OrgContext): Promise<AuditHealthSnapshot>;
  /**
   * Atomically latch observations, resolve absent conditions and return the persistent state.
   * Throws AuditHealthConflictError without writing when stored health no longer matches `current`.
   */
  observe(
    ctx: OrgContext,
    observations: readonly AuditHealthObservation[],
    current?: readonly AuditHealthStoredAlert[],
  ): Promise<{
    readonly alerts: readonly AuditHealthAlert[];
    readonly raised: readonly AuditAlertCode[];
  }>;
  /** A stale acknowledgement must never clear a newer occurrence. */
  acknowledge(ctx: OrgContext, code: AuditAlertCode, revision: number): Promise<boolean>;
}
export interface AuditHealth {
  readonly status: 'ok' | 'degraded' | 'failing';
  readonly codes: readonly AuditAlertCode[];
}

const OBSERVE_ATTEMPTS = 3;

export class AuditHealthConflictError extends Error {
  constructor() {
    super('Audit health changed concurrently');
    this.name = 'AuditHealthConflictError';
  }
}

export function createAuditHealthService(deps: {
  readonly port: AuditHealthPort;
  readonly clock: Clock;
  readonly observability: Observability;
}) {
  const emit = (code: AuditAlertCode) => {
    try {
      deps.observability.log({ level: 'error', event: 'audit.alert', reason_code: code });
    } catch {
      // Log and metric delivery are independent.
    }
    try {
      deps.observability.counter('pb.audit.alerts_total', { code });
    } catch {
      // The durable health state remains available when telemetry fails.
    }
  };
  return {
    async raise(ctx: OrgContext, code: AuditAlertCode): Promise<void> {
      if (!AUDIT_ALERT_CODES.includes(code)) throw new TypeError('Invalid audit alert code');
      emit(code);
      await deps.port.raise(ctx, code);
    },
    async read(ctx: OrgContext): Promise<AuditHealth> {
      for (let attempt = 1; ; attempt++) {
        try {
          return await observe(ctx);
        } catch (error) {
          if (!(error instanceof AuditHealthConflictError) || attempt === OBSERVE_ATTEMPTS)
            throw error;
        }
      }
    },
  };
  async function observe(ctx: OrgContext): Promise<AuditHealth> {
    const snapshot = await deps.port.snapshot(ctx);
    const observations = [...snapshot.incidents];
    const live = new Map<AuditAlertCode, AuditHealthObservation>();
    const add = (code: AuditAlertCode, fingerprint = 'active', failing = false) => {
      const prior = live.get(code);
      live.set(code, {
        code,
        origin: 'live',
        fingerprint: prior === undefined ? fingerprint : `${prior.fingerprint}|${fingerprint}`,
        failing: failing || prior?.failing === true,
      });
    };
    if (snapshot.mode === 'none') add('audit.mode_none');
    if (snapshot.capacityState !== 'ok')
      add('audit.capacity', snapshot.capacityState, snapshot.capacityState === 'refusing');
    if (snapshot.restorePending) add('audit.fork', 'restore', true);
    const blocked = snapshot.sinks.filter((sink) => sink.state === 'blocked');
    if (blocked.length > 0)
      add(
        'audit.blocked',
        blocked
          .map((sink) => sink.id)
          .sort()
          .join('|'),
        true,
      );
    const forked = blocked.filter((sink) => sink.blockedReason === 'fork');
    if (forked.length > 0)
      add(
        'audit.fork',
        forked
          .map((sink) => sink.id)
          .sort()
          .join('|'),
        true,
      );
    const inactive = snapshot.sinks.filter((sink) => sink.state === 'inactive');
    if (inactive.length > 0)
      add(
        'audit.sink_inactive',
        inactive
          .map((sink) => `${sink.id}:${sink.state}`)
          .sort()
          .join('|'),
      );
    if (snapshot.oldestPendingAt !== null) {
      const age = deps.clock.now().getTime() - Date.parse(snapshot.oldestPendingAt);
      if (!Number.isFinite(age) || age > 300_000) add('audit.pending_old');
    }
    const state = await deps.port.observe(
      ctx,
      [...observations, ...live.values()],
      snapshot.alerts,
    );
    for (const code of state.raised) emit(code);
    const outstanding = state.alerts.filter(
      (alert) => alert.active || alert.revision > alert.acknowledgedRevision,
    );
    return {
      status: outstanding.some((alert) => alert.active && alert.failing)
        ? 'failing'
        : outstanding.length > 0
          ? 'degraded'
          : 'ok',
      codes: [...new Set(outstanding.map((alert) => alert.code))].sort(),
    };
  }
}

export async function raiseAuditAlert(
  health: Pick<AuditHealthPort, 'raise'> | undefined,
  ctx: OrgContext,
  code: AuditAlertCode,
): Promise<void> {
  try {
    await health?.raise(ctx, code);
  } catch {
    // Alert delivery must not change the outcome of the operation it describes.
  }
}
