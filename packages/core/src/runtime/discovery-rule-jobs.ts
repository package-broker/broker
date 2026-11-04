import { auditEvent, type AuditAction, type AuditEvent } from '../audit/actions.js';
import { discoveryRuleFence } from '../authz/fence.js';
import type { DiscoveryRuleRepository, DiscoveryRuleState } from '../db/discovery-rules.js';
import type { CoreJobs } from '../platform/jobs.js';
import type { Clock } from '../ids.js';
import type { RegisteredCoreJob } from '../kernel/registry.js';
import { jobLeaseOf } from '../platform/job-fences.js';
import { requirePlatformPorts } from '../plugin.js';
import { JobError } from '../platform/jobs.js';
import type { BulkDiscovery } from '../sources/bulk-discovery.js';
import { registerCoreJob } from './core-jobs.js';

export interface DiscoveryRuleJobDeps {
  readonly forInvocation?: () => DiscoveryRuleJobDeps;
  readonly jobs?: CoreJobs;
  readonly rules: DiscoveryRuleRepository;
  readonly discovery: BulkDiscovery;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
}
export function discoveryRuleAudit(
  deps: Pick<DiscoveryRuleJobDeps, 'clock' | 'ids'>,
  ruleId: string,
  action: AuditAction,
): AuditEvent {
  const id = deps.ids.ulid();
  const result = auditEvent({
    id,
    now: deps.clock.now().toISOString(),
    action,
    actor: { type: 'system', id: ruleId },
    target: { type: 'discovery_rule', id: ruleId },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
  });
  if (!result.ok) throw new TypeError('invalid discovery audit');
  return result.event;
}

/** Bounded planning and admission; unfinished work resumes on the next tick. */
export function discoveryRuleJobs(
  resolve: () => DiscoveryRuleJobDeps,
): readonly RegisteredCoreJob[] {
  return [
    registerCoreJob({
      name: 'discovery-rules',
      version: 1,
      schedule: { everySeconds: 60 },
      validate: () => ({}),
      async handler(_payload, job) {
        const resolved = resolve();
        const deps = resolved.forInvocation?.() ?? resolved;
        if (job.signal.aborted || jobLeaseOf(job) === null) throw new JobError('lease_lost');
        for (const rule of await deps.rules.due(job.org, deps.clock.now().toISOString())) {
          await (deps.jobs ?? requirePlatformPorts(job.ports).jobs).enqueue(
            job.org,
            'core:discovery-rule:v1',
            { ruleId: rule.id, revision: rule.revision },
            {
              resourceKey: `discovery-rule:${rule.id}`,
              idempotencyKey: `discovery:${rule.id}:${rule.revision}:${Math.floor(deps.clock.now().getTime() / 60000)}`,
            },
          );
        }
      },
    }),
    registerCoreJob({
      name: 'discovery-rule',
      version: 1,
      validate(value) {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('ruleId' in value) ||
          typeof value.ruleId !== 'string' ||
          !('revision' in value) ||
          !Number.isSafeInteger(value.revision) ||
          (value.revision as number) < 1
        )
          throw new JobError('invalid_payload');
        return { ruleId: value.ruleId, revision: value.revision as number };
      },
      async handler(payload, job) {
        const { ruleId, revision } = payload as { ruleId: string; revision: number };
        const resolved = resolve();
        const deps = resolved.forInvocation?.() ?? resolved;
        const discovery = deps.discovery.forInvocation?.() ?? deps.discovery;
        const lease = jobLeaseOf(job);
        if (lease === null || job.signal.aborted) throw new JobError('lease_lost');
        const rule = await deps.rules.get(job.org, ruleId);
        const now = deps.clock.now();
        if (
          rule === null ||
          !rule.enabled ||
          rule.revision !== revision ||
          (rule.nextRunAt !== null && rule.nextRunAt > now.toISOString())
        )
          return;
        const fence = discoveryRuleFence(
          rule.id,
          rule.revision,
          rule.credentialId,
          rule.installationId,
          lease,
        );
        const actor = { kind: 'rule', ruleId: rule.id } as const;
        let state: DiscoveryRuleState =
          rule.outcome === 'running' ||
          rule.outcome === 'rate_limited' ||
          rule.failureReason === 'disabled'
            ? rule
            : {
                lastRunAt: now.toISOString(),
                outcome: 'running',
                created: 0,
                existing: 0,
                skipped: 0,
                failed: 0,
                skips: [],
                cursor: '1',
                remaining: [],
                nextRunAt: null,
              };
        const starting =
          rule.outcome !== 'running' &&
          rule.outcome !== 'rate_limited' &&
          rule.failureReason !== 'disabled';
        let startAudit = starting
          ? discoveryRuleAudit(deps, rule.id, 'discovery_rule.run_started')
          : undefined;
        const deadline = (seconds: number) =>
          new Date(deps.clock.now().getTime() + seconds * 1000).toISOString();
        const backoff = (seconds = 300) => deadline(Math.min(3600, Math.max(300, seconds)));
        const transient = (error: string) =>
          ['upstream_status', 'invalid_response', 'timeout', 'network', 'busy', 'unknown'].includes(
            error,
          );
        const retry = async (error: string, seconds?: number) => {
          const failures = (state.consecutiveFailures ?? 0) + (error === 'rate_limited' ? 0 : 1);
          const terminal = error !== 'rate_limited' && (!transient(error) || failures >= 5);
          await checkpoint(
            {
              ...state,
              consecutiveFailures: failures,
              outcome: terminal ? 'failed' : error === 'rate_limited' ? 'rate_limited' : 'running',
              ...(terminal
                ? {
                    created:
                      state.created +
                      (state.pendingResults ?? []).filter((r) => r.outcome === 'created').length,
                    existing:
                      state.existing +
                      (state.pendingResults ?? []).filter((r) => r.outcome === 'existing').length,
                    skipped:
                      state.skipped +
                      (state.pendingResults ?? []).filter((r) => r.outcome === 'skipped').length,
                    skips: [
                      ...state.skips,
                      ...(state.pendingResults ?? [])
                        .filter((r) => r.outcome === 'skipped')
                        .map((r) => ({ repository: r.repository, reason: r.reason ?? null })),
                    ].slice(0, 50),
                    pendingResults: [],
                  }
                : {}),
              failureReason: terminal ? 'discovery_failed' : null,
              failed: state.failed + (terminal ? 1 : 0),
              nextRunAt: terminal
                ? deadline(rule.intervalSeconds)
                : backoff(seconds ?? 300 * 2 ** Math.max(0, failures - 1)),
            },
            terminal,
          );
        };
        const checkpoint = async (next: DiscoveryRuleState, finished = false) => {
          if (next.outcome === 'running' && next.cursor === null && next.remaining.length === 0) {
            next = {
              ...next,
              outcome: next.failed > 0 ? 'failed' : 'succeeded',
              nextRunAt: new Date(now.getTime() + rule.intervalSeconds * 1000).toISOString(),
            };
            finished = true;
          }
          if (next.outcome === 'running' && next.nextRunAt === null) {
            next = { ...next, nextRunAt: new Date(now.getTime() + 60000).toISOString() };
          }
          if (job.signal.aborted) throw new JobError('aborted');
          if (
            !(await deps.rules.checkpoint(job.org, fence, next, [
              ...(startAudit === undefined ? [] : [startAudit]),
              ...(finished
                ? [discoveryRuleAudit(deps, rule.id, 'discovery_rule.run_finished')]
                : []),
            ]))
          )
            throw new JobError('lease_lost');
          state = next;
          startAudit = undefined;
        };
        state = { ...state, outcome: 'running', failureReason: null };
        const input = {
          credentialId: rule.credentialId,
          installationId: rule.installationId,
          includeForks: rule.includeForks,
          ...(rule.ecosystem === 'both' ? {} : { ecosystem: rule.ecosystem }),
        };
        if (state.remaining.length === 0) {
          const page = await discovery.dryRun(
            job.org,
            actor,
            {
              ...input,
              pattern: rule.pattern,
              cursor: state.cursor,
            },
            fence,
          );
          if (!page.ok) {
            await retry(page.error, page.retryAfterSeconds);
            return;
          }
          const remaining = [
            ...new Set(
              page.value.entries.filter((e) => e.action === 'new').map((e) => e.repository),
            ),
          ];
          const skipped = page.value.entries.filter(
            (e) => e.action === 'skipped' && !remaining.includes(e.repository),
          );
          const skips = [
            ...state.skips,
            ...skipped.map((e) => ({
              repository: e.repository,
              reason: e.reason,
            })),
          ].slice(0, 50);
          state = {
            ...state,
            consecutiveFailures: 0,
            cursor: page.value.nextCursor,
            remaining,
            existing:
              state.existing +
              page.value.entries.filter(
                (e) => e.action === 'existing' && !remaining.includes(e.repository),
              ).length,
            skipped: state.skipped + skipped.length,
            skips,
          };
        }
        if (state.remaining.length > 0) {
          if (discovery.budgetSpent?.()) {
            await checkpoint(state);
            return;
          }
          const operationId = deps.ids.ulid();
          const applied = await discovery.apply(
            job.org,
            actor,
            fence,
            {
              ...input,
              repositories: state.remaining.slice(0, 20),
              nextCursor: state.cursor,
              completedResults: state.pendingResults ?? [],
            },
            {
              audit: {
                opId: operationId,
                requestId: operationId,
                sourceIp: null,
                tokenSelector: null,
              },
            },
          );
          if (!applied.ok) {
            await retry(applied.error, applied.retryAfterSeconds);
            return;
          }
          const v = applied.value;
          const limited = v.results.some((r) => r.error === 'rate_limited');
          const retryable = v.results.find(
            (r) => r.error !== undefined && r.retryable !== false && transient(r.error),
          );
          const retryErrors = v.results.filter(
            (r) =>
              r.error === 'rate_limited' ||
              (r.error !== undefined && r.retryable !== false && transient(r.error)),
          ).length;
          const pending = v.results.filter(
            (r) => v.remainingRepositories.includes(r.repository) && r.outcome !== 'failed',
          );
          const settled = v.results.filter((r) => !v.remainingRepositories.includes(r.repository));
          const count = (outcome: string) => settled.filter((r) => r.outcome === outcome).length;
          state = {
            ...state,
            pendingResults: pending,
            consecutiveFailures:
              limited || retryable !== undefined ? (state.consecutiveFailures ?? 0) : 0,
            outcome: limited ? 'rate_limited' : 'running',
            remaining: [...v.remainingRepositories, ...state.remaining.slice(20)],
            created: state.created + count('created'),
            existing: state.existing + count('existing'),
            skipped: state.skipped + count('skipped'),
            failed: state.failed + v.failed - retryErrors,
            skips: [
              ...state.skips,
              ...settled
                .filter((r) => r.outcome === 'skipped')
                .map((r) => ({
                  repository: r.repository,
                  reason: r.reason ?? null,
                })),
            ].slice(0, 50),
            nextRunAt: limited
              ? new Date(
                  deps.clock.now().getTime() +
                    Math.min(3600, Math.max(300, applied.retryAfterSeconds ?? 0)) * 1000,
                ).toISOString()
              : null,
          };
          if (limited || retryable !== undefined) {
            await retry(limited ? 'rate_limited' : retryable!.error!, applied.retryAfterSeconds);
            return;
          }
        }
        await checkpoint(state);
      },
    }),
  ];
}
