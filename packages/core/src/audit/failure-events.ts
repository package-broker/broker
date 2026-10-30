import type { OrgContext } from '../db/port.js';
import { ulid } from '../ids.js';
import type { BoundCacheKey, Cache, CacheEnvelope } from '../platform/cache.js';
import type { Observability } from '../platform/observability.js';
import {
  auditEvent,
  type AuditContext,
  type AuditEvent,
  type LOGIN_FAILURE_METHODS,
  type LOGIN_FAILURE_REASONS,
} from './actions.js';

export interface AuditFailurePort {
  stage(ctx: OrgContext, event: AuditEvent): Promise<void>;
}

export type FailureAttempt = {
  readonly context: Pick<AuditContext, 'sourceIp'>;
} & (
  | {
      readonly action: 'session.login_failed';
      readonly userId: string | null;
      readonly method: (typeof LOGIN_FAILURE_METHODS)[number];
      readonly reason: (typeof LOGIN_FAILURE_REASONS)[number];
    }
  | {
      readonly action: 'access.denied';
      readonly actor: {
        readonly type: 'user' | 'service_principal' | 'customer';
        readonly id: string;
      };
      readonly routeTemplate: string;
      readonly permission: string | null;
      readonly boundary: 'organization' | 'project' | 'authenticated';
      readonly projectId?: string | null;
    }
);

export interface FailureEventsOptions {
  /** Override only with a dedicated bounded counter cache when available. */
  readonly cache?: Cache;
  readonly staging: AuditFailurePort;
  readonly observability: Observability;
  readonly deploymentId: string;
  /** Templates from the compiled route registry, never request paths. */
  readonly routeTemplates: ReadonlySet<string>;
  readonly now?: () => Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const THRESHOLDS = new Set([1, 10, 100, 1000]);
const MAX_QUEUE_DEPTH = 64;
const MAX_COUNTERS = 4096;

function counterCache(): Cache {
  const entries = new Map<string, CacheEnvelope>();
  return {
    async get(ctx, key) {
      const id = JSON.stringify([ctx.orgId, key.digest]);
      const entry = entries.get(id);
      if (entry === undefined) return null;
      entries.delete(id);
      entries.set(id, entry);
      return { entry, state: 'fresh' };
    },
    async set(ctx, key, entry) {
      const id = JSON.stringify([ctx.orgId, key.digest]);
      entries.delete(id);
      entries.set(id, entry);
      if (entries.size > MAX_COUNTERS) entries.delete(entries.keys().next().value!);
    },
    async delete(ctx, key) {
      entries.delete(JSON.stringify([ctx.orgId, key.digest]));
    },
  };
}

/** Create one recorder per isolate, never per request or organization; limiter state lives here. */
export function createFailureEvents(options?: FailureEventsOptions): {
  record(ctx: OrgContext, attempt: FailureAttempt, binding?: FailureEventsOptions): Promise<void>;
  /** Runtime background-lifetime tracking; never awaited by authentication. */
  drain(ctx: OrgContext): Promise<void>;
} {
  // Cache read/modify/write is serialized here; across isolates the limiter is best effort.
  const queues = new Map<string, { tail: Promise<void>; depth: number }>();
  const cache = options?.cache ?? counterCache();
  function report(
    options: FailureEventsOptions,
    event: string,
    level: 'warn' | 'error' = 'error',
    reasonCode?: 'no_ip_key_saturated' | 'org_cap_reached',
  ): void {
    try {
      options.observability.log({
        level,
        event,
        ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
      });
    } catch {
      /* Observability cannot affect auth. */
    }
  }
  function suppressed(options: FailureEventsOptions): void {
    try {
      options.observability.counter('pb.audit.failure_events_suppressed');
    } catch {
      /* Same boundary as logging. */
    }
  }
  async function key(
    options: FailureEventsOptions,
    ctx: OrgContext,
    parts: readonly unknown[],
  ): Promise<BoundCacheKey> {
    const bytes = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(
        JSON.stringify(['pb-audit-failure', 1, options.deploymentId, ctx.orgId, ...parts]),
      ),
    );
    return {
      projectId: 'audit-failure',
      sourceId: 'audit-failure',
      kind: 'metadata',
      digest: Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join(''),
    };
  }
  async function increment(
    ctx: OrgContext,
    cacheKey: BoundCacheKey,
    start: string,
    end: string,
  ): Promise<number> {
    const hit = await cache.get(ctx, cacheKey);
    let count = 0;
    if (hit !== null && hit.state === 'fresh' && hit.entry.freshUntil === end) {
      const stored: unknown = JSON.parse(decoder.decode(hit.entry.value));
      if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 0) {
        throw new Error('invalid audit failure counter');
      }
      count = stored;
    }
    count = Math.min(count + 1, Number.MAX_SAFE_INTEGER);
    await cache.set(ctx, cacheKey, {
      value: encoder.encode(JSON.stringify(count)),
      freshUntil: end,
      staleUntil: null,
      negative: false,
      insertedAt: start,
    });
    return count;
  }
  async function record(
    ctx: OrgContext,
    attempt: FailureAttempt,
    options: FailureEventsOptions,
  ): Promise<void> {
    try {
      const at = options.now?.() ?? new Date();
      const start = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
      const end = new Date(Date.parse(start) + 60_000).toISOString();
      const login = attempt.action === 'session.login_failed';
      if (!login && !options.routeTemplates.has(attempt.routeTemplate)) {
        suppressed(options);
        report(options, 'audit.failure_event_invalid');
        return;
      }
      const id = ulid(at.getTime());
      const result = auditEvent({
        id,
        now: at.toISOString(),
        action: attempt.action,
        actor: login
          ? attempt.userId === null
            ? { type: 'system', id: null }
            : { type: 'user', id: attempt.userId }
          : attempt.actor,
        context: {
          opId: id,
          requestId: id,
          sourceIp: attempt.context.sourceIp,
          tokenSelector: null,
        },
        target: login
          ? { type: 'session', id: null }
          : { type: 'route', id: attempt.routeTemplate },
        projectId: login ? null : (attempt.projectId ?? null),
        changes: {
          ...(login
            ? { method: { new: attempt.method }, reason: { new: attempt.reason } }
            : { permission: { new: attempt.permission }, boundary: { new: attempt.boundary } }),
          count: { new: 1 },
          window_start: { new: start },
        },
      });
      if (!result.ok) {
        suppressed(options);
        report(options, 'audit.failure_event_invalid');
        return;
      }
      const actorId = login ? attempt.userId : attempt.actor.id;
      const keyClass =
        actorId !== null ? 'actor' : attempt.context.sourceIp !== null ? 'ip' : 'no-ip';
      const count = await increment(
        ctx,
        await key(options, ctx, [
          start,
          attempt.action,
          keyClass,
          actorId ?? attempt.context.sourceIp,
          login ? attempt.method : attempt.routeTemplate,
          login ? null : attempt.permission,
        ]),
        start,
        end,
      );
      if (keyClass === 'no-ip' && count === 1000)
        report(options, 'audit.failure_events_cap', 'warn', 'no_ip_key_saturated');
      if (!THRESHOLDS.has(count)) {
        suppressed(options);
        return;
      }
      const total = await increment(ctx, await key(options, ctx, [start, 'org-cap']), start, end);
      if (total > 600) {
        suppressed(options);
        if (total === 601) report(options, 'audit.failure_events_cap', 'warn', 'org_cap_reached');
        return;
      }
      const payload = JSON.parse(result.event.payloadJson) as {
        changes: { count: { new: number } };
      };
      payload.changes.count.new = count;
      await options.staging.stage(ctx, { ...result.event, payloadJson: JSON.stringify(payload) });
    } catch {
      suppressed(options);
      report(options, 'audit.failure_event_failed');
    }
  }
  return {
    async record(ctx, attempt, binding = options) {
      if (binding === undefined) throw new TypeError('Failure events binding is not wired');
      let queue = queues.get(ctx.orgId);
      if (queue !== undefined && queue.depth >= MAX_QUEUE_DEPTH) {
        suppressed(binding);
        return;
      }
      if (queue === undefined) {
        queue = { tail: Promise.resolve(), depth: 0 };
        queues.set(ctx.orgId, queue);
      }
      queue.depth++;
      const current = queue;
      current.tail = current.tail
        .then(() => record(ctx, attempt, binding))
        .finally(() => {
          current.depth--;
          if (current.depth === 0) queues.delete(ctx.orgId);
        });
    },
    drain(ctx) {
      return queues.get(ctx.orgId)?.tail ?? Promise.resolve();
    },
  };
}
