import { PackageNameError, packageKey } from '../catalogue/names.js';
import type { ApiCall } from '../api/idempotency.js';
import type { ActorContext } from '../authz/administration.js';
import type { MutationFence } from '../authz/fence.js';
import { DbError } from '../db/errors.js';
import type { OrgContext } from '../db/port.js';
import type { DiscoveryCandidate, PlanEntry, SkipReason } from './plan.js';
import { UpstreamError, type UpstreamCredential } from './policy-fetch.js';
import type { SourceService } from './source-service.js';

export const MAX_APPLY_REPOSITORIES = 20;

export interface DiscoveryPlanPage {
  readonly entries: readonly PlanEntry[];
  readonly nextCursor: string | null;
}

export interface DiscoveryCredential {
  readonly credentialId: string;
  readonly installationId: number;
  readonly upstream: UpstreamCredential;
}

type ExistsLookup = (candidate: DiscoveryCandidate) => boolean | Promise<boolean>;

export interface BulkDiscoveryDeps {
  readonly credentials: {
    /** Must return only an organization-level github_app credential owned by ctx's organization. */
    resolve(ctx: OrgContext, credentialId: string): Promise<DiscoveryCredential | null>;
  };
  readonly discovery: {
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
    ): Promise<boolean>;
    /** Exact source-name lookup among organization-level sources in ctx's organization. */
    hasSourceName(ctx: OrgContext, name: string): Promise<boolean>;
  };
}

export type BulkDiscoveryResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface ApplyOutcome {
  readonly repository: string;
  readonly outcome: 'created' | 'existing' | 'skipped' | 'failed';
  readonly error?: string;
  readonly reason?: SkipReason | 'unsupported_ecosystem';
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
  dryRun(
    ctx: OrgContext,
    actor: ActorContext,
    input: {
      readonly credentialId: string;
      readonly includeForks?: boolean;
      readonly ecosystem?: 'composer' | 'npm';
      readonly pattern: string;
      readonly cursor: string | null;
    },
  ): Promise<BulkDiscoveryResult<DiscoveryPlanPage>>;
  apply(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
    input: {
      readonly credentialId: string;
      readonly includeForks?: boolean;
      readonly ecosystem?: 'composer' | 'npm';
      readonly repositories: readonly string[];
      readonly nextCursor?: string | null;
    },
    call: ApiCall,
  ): Promise<BulkDiscoveryResult<ApplySummary>>;
}

const forbidden = { ok: false, error: 'forbidden' } as const;

function discoveryErrorCode(error: unknown): string | undefined {
  if (error instanceof UpstreamError) return error.code;
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

export function createBulkDiscovery(deps: BulkDiscoveryDeps): BulkDiscovery {
  const permitted = (actor: ActorContext): boolean =>
    actor.kind === 'organization' && actor.permissions.has('org:sources:write');

  async function applyOne(
    ctx: OrgContext,
    actor: ActorContext,
    fence: MutationFence,
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
        reason:
          entry.reason ?? (entry.ecosystem === null ? 'unsupported_ecosystem' : 'invalid_name'),
      };
    }
    try {
      if (packageKey(entry.packageName, { ecosystem: entry.ecosystem }) !== entry.packageName)
        return { repository, outcome: 'skipped', reason: 'invalid_name' };
    } catch (error) {
      if (!(error instanceof PackageNameError)) throw error;
      return { repository, outcome: 'skipped', reason: 'invalid_name' };
    }
    const who = { kind: 'org', actor } as const;
    const created = await deps.sources.create(
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
    const named = await deps.sources.addRegisteredName(
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
    async dryRun(ctx, actor, input) {
      if (!permitted(actor)) return forbidden;
      try {
        const credential = await deps.credentials.resolve(ctx, input.credentialId);
        if (credential === null) return { ok: false, error: 'credential_not_found' };
        const page = await deps.discovery.discover(ctx, credential, {
          pattern: input.pattern,
          includeForks: input.includeForks === true,
          ...(input.ecosystem === undefined ? {} : { ecosystem: input.ecosystem }),
          cursor: input.cursor,
          exists: (candidate) =>
            deps.existingRepository.has(ctx, candidate.repository, candidate.ecosystem),
        });
        return { ok: true, value: page };
      } catch (error) {
        const code = discoveryErrorCode(error);
        if (code === undefined) throw error;
        return { ok: false, error: code };
      }
    },
    async apply(ctx, actor, fence, input, call) {
      if (!permitted(actor)) return forbidden;
      if (fence.userId !== actor.userId) {
        throw new TypeError('the mutation fence must belong to the acting user');
      }
      if (input.repositories.length > MAX_APPLY_REPOSITORIES) {
        return { ok: false, error: 'too_many_repositories' };
      }
      if (new Set(input.repositories).size !== input.repositories.length) {
        return { ok: false, error: 'invalid_repositories' };
      }
      const credential = await deps.credentials.resolve(ctx, input.credentialId);
      if (credential === null) return { ok: false, error: 'credential_not_found' };
      const results: ApplyOutcome[] = [];
      let remainingRepositories: readonly string[] = [];
      for (const [index, repository] of input.repositories.entries()) {
        try {
          const entries = await deps.discovery.plan(
            ctx,
            credential,
            repository,
            (candidate) =>
              deps.existingRepository.has(ctx, candidate.repository, candidate.ecosystem),
            {
              includeForks: input.includeForks === true,
              ...(input.ecosystem === undefined ? {} : { ecosystem: input.ecosystem }),
            },
          );
          for (const entry of entries) {
            results.push(await applyOne(ctx, actor, fence, credential, repository, call, entry));
          }
        } catch (error) {
          const code = error instanceof DbError ? error.kind : discoveryErrorCode(error);
          if (code === undefined) throw error;
          results.push({ repository, outcome: 'failed', error: code });
          if (code === 'rate_limited') {
            remainingRepositories = input.repositories.slice(index);
            break;
          }
        }
      }
      const count = (outcome: ApplyOutcome['outcome']): number =>
        results.filter((result) => result.outcome === outcome).length;
      return {
        ok: true,
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
