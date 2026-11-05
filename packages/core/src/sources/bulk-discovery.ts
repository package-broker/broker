import { DiscoveryError } from './github-discovery.js';
import { InstallationTokenError } from './github-installation-token.js';
import { PackageNameError, packageKey } from '../catalogue/names.js';
import type { ApiCall } from '../api/idempotency.js';
import type { ActorContext } from '../authz/administration.js';
import type { DiscoveryRuleFence, SourceMutationFence } from '../authz/fence.js';
import { DbError } from '../db/errors.js';
import type { OrgContext } from '../db/port.js';
import type { DiscoveryCandidate, PlanEntry, SkipReason } from './plan.js';
import { UpstreamError, type UpstreamCredential } from './policy-fetch.js';
import type { SourceService } from './source-service.js';

export const MAX_APPLY_REPOSITORIES = 20;
// Workers Paid permits 1,000 D1 queries; use the documented 450-statement chunk.
export const DISCOVERY_STATEMENT_BUDGET = 450;
export const DISCOVERY_CHECKPOINT_RESERVE = 30;
export const DISCOVERY_REPOSITORY_RESERVE = 100;

export interface DiscoveryPlanPage {
  readonly entries: readonly PlanEntry[];
  readonly nextCursor: string | null;
}

export interface DiscoveryCredential {
  readonly credentialId: string;
  readonly installationId: number;
  readonly upstream: UpstreamCredential;
}

export type DiscoveryActor = ActorContext | { readonly kind: 'rule'; readonly ruleId: string };

type ExistsLookup = (candidate: DiscoveryCandidate) => boolean | Promise<boolean>;

export interface BulkDiscoveryDeps {
  readonly repositoriesPerInvocation?: number;
  readonly invocationStarted?: number;
  readonly invocationStatementStart?: number;
  readonly clock?: { now(): Date };
  readonly authority?: (ctx: OrgContext, fence: DiscoveryRuleFence) => Promise<boolean>;
  readonly statementCount?: () => number;
  readonly credentials: {
    /** Must return only an organization-level github_app credential owned by ctx's organization. */
    resolve(
      ctx: OrgContext,
      credentialId: string,
      installationId?: number,
    ): Promise<DiscoveryCredential | null>;
  };
  readonly discovery: {
    prepare?(
      ctx: OrgContext,
      credential: DiscoveryCredential,
      repositories: readonly string[],
    ): Promise<void>;
    discover(
      ctx: OrgContext,
      credential: DiscoveryCredential,
      request: {
        readonly pattern: string;
        readonly includeForks?: boolean;
        readonly ecosystem?: 'composer' | 'npm';
        readonly cursor: string | null;
        readonly exists: ExistsLookup;
      },
    ): Promise<DiscoveryPlanPage>;
    plan(
      ctx: OrgContext,
      credential: DiscoveryCredential,
      repository: string,
      exists: ExistsLookup,
      options?: { readonly includeForks?: boolean; readonly ecosystem?: 'composer' | 'npm' },
    ): Promise<readonly PlanEntry[]>;
  };
  readonly sources: Pick<SourceService, 'create' | 'addRegisteredName' | 'enable' | 'delete'>;
  readonly existingRepository: {
    has(
      ctx: OrgContext,
      repository: string,
      ecosystem: DiscoveryCandidate['ecosystem'],
      fence?: DiscoveryRuleFence,
    ): Promise<boolean>;
    /** Exact source-name lookup among organization-level sources in ctx's organization. */
    hasSourceName(ctx: OrgContext, name: string): Promise<boolean>;
    pending?(
      ctx: OrgContext,
      fence: DiscoveryRuleFence,
      repository: string,
      ecosystem: string,
    ): Promise<{ id: string; named: boolean } | null>;
  };
}

export type BulkDiscoveryResult<T> =
  | { readonly ok: true; readonly value: T; readonly retryAfterSeconds?: number }
  | { readonly ok: false; readonly error: string; readonly retryAfterSeconds?: number };

export interface ApplyOutcome {
  readonly ecosystem?: 'composer' | 'npm' | null;
  readonly repository: string;
  readonly outcome: 'created' | 'existing' | 'skipped' | 'failed';
  readonly error?: string;
  readonly retryable?: boolean;
  readonly reason?: SkipReason | null;
}

export interface ApplySummary {
  readonly created: number;
  readonly existing: number;
  readonly skipped: number;
  readonly failed: number;
  readonly results: readonly ApplyOutcome[];
  /** Retry the rate-limited repository, then the repositories not yet attempted. */
  readonly remainingRepositories: readonly string[];
  readonly nextCursor: string | null;
}

export interface BulkDiscovery {
  forInvocation?(): BulkDiscovery;
  budgetSpent?(): boolean;
  dryRun(
    ctx: OrgContext,
    actor: DiscoveryActor,
    input: {
      readonly credentialId: string;
      readonly installationId?: number;
      readonly includeForks?: boolean;
      readonly ecosystem?: 'composer' | 'npm';
      readonly pattern: string;
      readonly cursor: string | null;
    },
    fence?: DiscoveryRuleFence,
  ): Promise<BulkDiscoveryResult<DiscoveryPlanPage>>;
  apply(
    ctx: OrgContext,
    actor: DiscoveryActor,
    fence: SourceMutationFence,
    input: {
      readonly credentialId: string;
      readonly installationId?: number;
      readonly includeForks?: boolean;
      readonly ecosystem?: 'composer' | 'npm';
      readonly repositories: readonly string[];
      readonly completedResults?: readonly ApplyOutcome[];
      readonly nextCursor?: string | null;
    },
    call: ApiCall,
  ): Promise<BulkDiscoveryResult<ApplySummary>>;
}

const forbidden = { ok: false, error: 'forbidden' } as const;

function discoveryErrorCode(error: unknown): string | undefined {
  if (error instanceof UpstreamError) return error.code;
  if (
    error instanceof DiscoveryError &&
    error.code === 'upstream_status' &&
    error.status !== undefined &&
    error.status < 500
  )
    return error.status === 401
      ? 'unauthorized'
      : error.status === 403
        ? 'forbidden'
        : error.status === 404
          ? 'not_found'
          : 'invalid_request';
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  if (error.name !== 'DiscoveryError' && error.name !== 'InstallationTokenError') return undefined;
  switch (error.code) {
    case 'invalid_request':
    case 'rate_limited':
    case 'upstream_status':
    case 'invalid_response':
      return error.code;
    case 'unauthorized':
    case 'forbidden':
    case 'not_found':
    case 'unprocessable':
      return error.name === 'InstallationTokenError' ? error.code : undefined;
    default:
      return undefined;
  }
}

function backoff(error: unknown, now: number): { readonly retryAfterSeconds?: number } {
  if (!(error instanceof DiscoveryError) && !(error instanceof InstallationTokenError)) return {};
  const reset = error instanceof InstallationTokenError ? error.rateLimit?.reset : undefined;
  const wait = Math.max(
    error.retryAfter ?? 0,
    reset === undefined ? 0 : Math.ceil(reset - now / 1000),
  );
  return Number.isSafeInteger(wait) && wait > 0 && wait <= 31536000
    ? { retryAfterSeconds: Math.min(3600, Math.max(300, wait)) }
    : {};
}

export function createBulkDiscovery(deps: BulkDiscoveryDeps): BulkDiscovery {
  const now = () => deps.clock?.now().getTime() ?? Date.now();
  const transient = (code: string) =>
    [
      'rate_limited',
      'upstream_status',
      'invalid_response',
      'timeout',
      'network',
      'busy',
      'unknown',
    ].includes(code);
  const permitted = (actor: DiscoveryActor): boolean =>
    actor.kind === 'rule' ||
    (actor.kind === 'organization' && actor.permissions.has('org:sources:write'));

  async function applyOne(
    ctx: OrgContext,
    actor: DiscoveryActor,
    fence: SourceMutationFence,
    credential: DiscoveryCredential,
    repository: string,
    call: ApiCall,
    entry: PlanEntry,
  ): Promise<ApplyOutcome> {
    if (entry.repository.toLowerCase() !== repository.toLowerCase()) {
      return { repository, outcome: 'failed', error: 'repository_mismatch' };
    }
    if (entry.action === 'existing') return { repository, outcome: 'existing' };
    if (
      entry.action !== 'new' ||
      (entry.ecosystem !== 'composer' && entry.ecosystem !== 'npm') ||
      entry.packageName === null
    ) {
      return {
        repository,
        outcome: 'skipped',
        reason: entry.reason ?? null,
      };
    }
    try {
      if (packageKey(entry.packageName, { ecosystem: entry.ecosystem }) !== entry.packageName)
        return { repository, outcome: 'skipped', reason: 'invalid_name' };
    } catch (error) {
      if (!(error instanceof PackageNameError)) throw error;
      return { repository, outcome: 'skipped', reason: 'invalid_name' };
    }
    const who = actor.kind === 'rule' ? actor : ({ kind: 'org', actor } as const);
    const pending =
      actor.kind === 'rule' && 'ruleId' in fence
        ? await deps.existingRepository.pending?.(ctx, fence, repository, entry.ecosystem)
        : null;
    const created = pending
      ? { ok: true as const, value: { id: pending.id } }
      : await deps.sources.create(
          ctx,
          who,
          fence,
          {
            projectId: null,
            credentialId: credential.credentialId,
            name: entry.packageName,
            ecosystem: entry.ecosystem,
            type: 'vcs',
            url: null,
            configJson: JSON.stringify({
              provider: 'github',
              repository,
              installationId: credential.installationId,
              packageName: entry.packageName,
              refs: { tags: true, branches: [] },
            }),
          },
          call,
        );
    if (!created.ok) {
      if (
        created.error === 'duplicate' &&
        (await deps.existingRepository.hasSourceName(ctx, entry.packageName))
      ) {
        return { repository, outcome: 'existing' };
      }
      return { repository, outcome: 'failed', error: created.error };
    }
    const sourceId = created.value.id;
    const item: ApiCall = { audit: call.audit };
    const named = pending?.named
      ? { ok: true as const }
      : await deps.sources.addRegisteredName(
          ctx,
          who,
          fence,
          { sourceId, pattern: entry.packageName },
          item,
        );
    if (!named.ok) {
      const deleted = await deps.sources.delete(ctx, who, fence, sourceId);
      if (!deleted.ok) {
        return { repository, outcome: 'failed', error: 'orphaned_paused_source' };
      }
      if (
        named.error === 'name_public' ||
        named.error === 'name_public_unverified' ||
        named.error === 'claim_overlap'
      )
        return { repository, outcome: 'skipped', reason: named.error };
      return named.error === 'pattern_taken' || named.error === 'duplicate'
        ? { repository, outcome: 'existing' }
        : { repository, outcome: 'failed', error: named.error };
    }
    const enabled = await deps.sources.enable(ctx, who, fence, sourceId, item);
    return enabled.ok
      ? { repository, outcome: 'created' }
      : { repository, outcome: 'failed', error: enabled.error };
  }

  return {
    budgetSpent: () =>
      deps.statementCount !== undefined &&
      deps.statementCount() - (deps.invocationStatementStart ?? 0) >=
        DISCOVERY_STATEMENT_BUDGET - DISCOVERY_CHECKPOINT_RESERVE - DISCOVERY_REPOSITORY_RESERVE,
    async dryRun(ctx, actor, input, fence) {
      if (!permitted(actor)) return forbidden;
      if (
        actor.kind === 'rule' &&
        (fence === undefined ||
          fence.ruleId !== actor.ruleId ||
          fence.credentialId !== input.credentialId ||
          fence.installationId !== input.installationId ||
          deps.authority === undefined ||
          !(await deps.authority(ctx, fence)))
      )
        return forbidden;
      try {
        const credential = await deps.credentials.resolve(
          ctx,
          input.credentialId,
          ...(input.installationId === undefined ? [] : [input.installationId]),
        );
        if (credential === null) return { ok: false, error: 'credential_not_found' };
        const page = await deps.discovery.discover(ctx, credential, {
          pattern: input.pattern,
          includeForks: input.includeForks === true,
          ...(input.ecosystem === undefined ? {} : { ecosystem: input.ecosystem }),
          cursor: input.cursor,
          exists: (candidate) =>
            deps.existingRepository.has(
              ctx,
              candidate.repository,
              candidate.ecosystem,
              actor.kind === 'rule' && fence !== undefined && 'ruleId' in fence ? fence : undefined,
            ),
        });
        return { ok: true, value: page };
      } catch (error) {
        if (error instanceof DbError && error.kind === 'backlog_full') throw error;
        const code = error instanceof DbError ? error.kind : discoveryErrorCode(error);
        if (code === undefined) throw error;
        return { ok: false, error: code, ...backoff(error, now()) };
      }
    },
    async apply(ctx, actor, fence, input, call) {
      if (!permitted(actor)) return forbidden;
      if (
        actor.kind === 'rule'
          ? !('ruleId' in fence) || fence.ruleId !== actor.ruleId
          : !('userId' in fence) || fence.userId !== actor.userId
      ) {
        throw new TypeError('the mutation fence must belong to the acting user');
      }
      if (
        actor.kind === 'rule' &&
        (!('ruleId' in fence) ||
          fence.credentialId !== input.credentialId ||
          fence.installationId !== input.installationId ||
          deps.authority === undefined ||
          !(await deps.authority(ctx, fence)))
      )
        return forbidden;
      if (input.repositories.length > MAX_APPLY_REPOSITORIES) {
        return { ok: false, error: 'too_many_repositories' };
      }
      if (new Set(input.repositories).size !== input.repositories.length) {
        return { ok: false, error: 'invalid_repositories' };
      }
      let credential: DiscoveryCredential | null;
      try {
        credential = await deps.credentials.resolve(
          ctx,
          input.credentialId,
          ...(input.installationId === undefined ? [] : [input.installationId]),
        );
        if (credential === null) return { ok: false, error: 'credential_not_found' };
        await deps.discovery.prepare?.(ctx, credential, input.repositories.slice(0, 3));
      } catch (error) {
        if (error instanceof DbError && error.kind === 'backlog_full') throw error;
        const code = error instanceof DbError ? error.kind : discoveryErrorCode(error);
        if (code === undefined) throw error;
        return { ok: false, error: code, ...backoff(error, now()) };
      }
      const results: ApplyOutcome[] = (input.completedResults ?? [])
        .filter((r) => input.repositories.includes(r.repository) && r.outcome !== 'failed')
        .slice();
      let retry: { readonly retryAfterSeconds?: number } = {};
      const started = now();
      const firstStatement = deps.statementCount?.() ?? 0;
      const limit = deps.repositoriesPerInvocation ?? MAX_APPLY_REPOSITORIES;
      let remainingRepositories: readonly string[] = input.repositories.slice(limit);
      repositories: for (const [index, repository] of input.repositories
        .slice(0, limit)
        .entries()) {
        if (
          now() - (deps.invocationStarted ?? started) >= 20000 ||
          (deps.statementCount !== undefined &&
            deps.statementCount() - (deps.invocationStatementStart ?? firstStatement) >=
              DISCOVERY_STATEMENT_BUDGET -
                DISCOVERY_CHECKPOINT_RESERVE -
                DISCOVERY_REPOSITORY_RESERVE)
        ) {
          remainingRepositories = input.repositories.slice(index);
          break;
        }
        try {
          const entries = await deps.discovery.plan(
            ctx,
            credential,
            repository,
            (candidate) =>
              deps.existingRepository.has(
                ctx,
                candidate.repository,
                candidate.ecosystem,
                actor.kind === 'rule' && fence !== undefined && 'ruleId' in fence
                  ? fence
                  : undefined,
              ),
            {
              includeForks: input.includeForks === true,
              ...(input.ecosystem === undefined ? {} : { ecosystem: input.ecosystem }),
            },
          );
          for (const entry of entries) {
            const prior = input.completedResults?.find(
              (r) =>
                r.repository === repository &&
                r.ecosystem === entry.ecosystem &&
                r.outcome !== 'failed',
            );
            const result = prior ?? {
              ...(await applyOne(ctx, actor, fence, credential, repository, call, entry)),
              ...(actor.kind === 'rule' ? { ecosystem: entry.ecosystem } : {}),
            };
            if (prior === undefined) results.push(result);
            if (
              actor.kind === 'rule' &&
              result.error !== undefined &&
              transient(result.error) &&
              result.retryable !== false
            ) {
              remainingRepositories = input.repositories.slice(index);
              break repositories;
            }
          }
        } catch (error) {
          if (error instanceof DbError && error.kind === 'backlog_full') throw error;
          const code = error instanceof DbError ? error.kind : discoveryErrorCode(error);
          if (code === undefined) throw error;
          for (const prior of input.completedResults ?? []) {
            if (
              prior.repository === repository &&
              !results.some((r) => r.repository === repository && r.ecosystem === prior.ecosystem)
            )
              results.push(prior);
          }
          results.push({
            repository,
            outcome: 'failed',
            error: code,
            ...((error instanceof DiscoveryError || error instanceof InstallationTokenError) &&
            error.status !== undefined &&
            error.status < 500 &&
            code !== 'rate_limited'
              ? { retryable: false }
              : {}),
          });
          if (
            code === 'rate_limited' ||
            (actor.kind === 'rule' && (code === 'busy' || code === 'unknown')) ||
            (actor.kind === 'rule' &&
              transient(code) &&
              !(
                (error instanceof DiscoveryError || error instanceof InstallationTokenError) &&
                error.status !== undefined &&
                error.status < 500
              ))
          ) {
            retry = backoff(error, now());
            remainingRepositories = input.repositories.slice(index);
            break;
          }
        }
      }
      const count = (outcome: ApplyOutcome['outcome']): number =>
        results.filter((result) => result.outcome === outcome).length;
      return {
        ok: true,
        ...retry,
        value: {
          created: count('created'),
          existing: count('existing'),
          skipped: count('skipped'),
          failed: count('failed'),
          results,
          remainingRepositories,
          nextCursor: input.nextCursor ?? null,
        },
      };
    },
  };
}
