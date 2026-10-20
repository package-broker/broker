import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type {
  DeliveryOutcome,
  WebhookDeliveries,
  WebhookEvent,
  WebhookTarget,
} from '@package-broker/core/sources/webhooks';

const OUTCOMES: ReadonlySet<string> = new Set(['received', 'processed', 'ignored', 'failed']);
const MAX_TEXT = 256;

function text(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
    throw new RangeError(
      `${name} must be a non-empty string of at most ${String(MAX_TEXT)} characters`,
    );
  }
  return value;
}

export function insertDeliveryStatement(
  ctx: OrgContext,
  input: { readonly provider: string; readonly deliveryId: string; readonly event: WebhookEvent },
): Statement {
  return {
    sql: `INSERT INTO webhook_delivery (org_id, provider, delivery_id, event, outcome)
      VALUES (?, ?, ?, ?, 'received')
      ON CONFLICT (provider, delivery_id) DO NOTHING`,
    params: [
      ctx.orgId,
      text('provider', input.provider),
      text('deliveryId', input.deliveryId),
      text('event', input.event),
    ],
  };
}

export function deliveryOutcomeStatement(
  ctx: OrgContext,
  input: { readonly provider: string; readonly deliveryId: string },
): Statement {
  return {
    sql: `SELECT outcome FROM webhook_delivery
      WHERE org_id = ? AND provider = ? AND delivery_id = ?`,
    params: [ctx.orgId, text('provider', input.provider), text('deliveryId', input.deliveryId)],
  };
}

export function settleDeliveryStatement(
  ctx: OrgContext,
  input: {
    readonly provider: string;
    readonly deliveryId: string;
    readonly outcome: 'processed' | 'ignored';
  },
): Statement {
  if (input.outcome !== 'processed' && input.outcome !== 'ignored') {
    throw new RangeError('outcome must be processed or ignored');
  }
  return {
    sql: `UPDATE webhook_delivery
      SET outcome = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE org_id = ? AND provider = ? AND delivery_id = ? AND outcome = 'received'`,
    params: [
      input.outcome,
      ctx.orgId,
      text('provider', input.provider),
      text('deliveryId', input.deliveryId),
    ],
  };
}

export function webhookSourcesStatement(ctx: OrgContext, target: WebhookTarget): Statement {
  if (!Number.isSafeInteger(target.installationId) || target.installationId < 1) {
    throw new RangeError('installationId must be a positive integer');
  }
  return {
    sql: `SELECT id FROM source
      WHERE org_id = ? AND type = 'vcs' AND credential_id = ? AND status <> 'paused'
        AND json_extract(config_json, '$.provider') = 'github'
        AND json_extract(config_json, '$.installationId') = ?
        AND lower(json_extract(config_json, '$.repository')) = ?
      ORDER BY id LIMIT 100`,
    params: [
      ctx.orgId,
      text('credentialId', target.credentialId),
      target.installationId,
      text('repository', target.repository).toLowerCase(),
    ],
  };
}

export function createWebhookDeliveryRepository(executor: SqlExecutor): WebhookDeliveries {
  return {
    async record(ctx, input) {
      const [insert, read] = await executor.batch([
        insertDeliveryStatement(ctx, input),
        deliveryOutcomeStatement(ctx, input),
      ]);
      const outcome = (read?.rows[0] as { outcome?: unknown } | undefined)?.outcome;
      if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
        throw new Error('webhook delivery is unavailable');
      }
      if (insert?.changes === 1) return { state: 'new' };
      return { state: 'duplicate', outcome: outcome as DeliveryOutcome };
    },

    async sourcesFor(ctx, target) {
      const rows = await executor.all<{ id: string }>(webhookSourcesStatement(ctx, target));
      return rows.map((row) => row.id);
    },

    async settle(ctx, input) {
      await executor.batch([settleDeliveryStatement(ctx, input)]);
    },
  };
}
