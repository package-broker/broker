import type { ApiCall } from '../api/idempotency.js';
import { redactValue } from '../audit/redact.js';
import { auditEvent, type AuditAction } from '../audit/actions.js';
import { isValidPattern } from '../catalogue/patterns.js';
import type { ActorContext, AdminLog } from '../authz/administration.js';
import type { MutationFence } from '../authz/fence.js';
import type { ProjectActor } from '../authz/project-actor.js';
import { PackageNameError, packageKey } from '../catalogue/names.js';
import type { CatalogueReader, WinnerCandidate } from '../db/catalogue.js';
import type { CredentialRepository } from '../db/credentials.js';
import type { OrganizationRepository } from '../db/organization.js';
import type { OrgContext } from '../db/port.js';
import type {
  NewSource,
  RegisteredNameRepository,
  RegisteredNameListQuery,
  RegisteredNamePage,
  RemovalRefusal,
  SourceChanges,
  SourceRecord,
  SourceRepository,
  SourceUpdate,
} from '../db/source.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import { checkRetentionOverride, parseSourceConfig, type SourceConfigProblem } from './config.js';
import { CredentialError, parseCredentialMaterial, type CredentialKind } from './credentials.js';
import { classifyUrl, type OutboundPolicy } from './url-policy.js';

export type SourceActor =
  | {
      readonly kind: 'org';
      readonly actor: ActorContext;
      readonly servicePrincipalId?: string;
      readonly restrictTo?: readonly string[];
    }
  | { readonly kind: 'project'; readonly actor: ProjectActor };

export interface SourceCredentialInput {
  readonly kind: CredentialKind;
  readonly plaintext: string | Uint8Array;
}

export type SourceCreateInput = Omit<NewSource, 'id' | 'credential' | 'providerAnchors'> & {
  readonly credential?: SourceCredentialInput | null;
  readonly credentialId?: string | null;
};
export type SourceUpdateInput = Omit<SourceChanges, 'credentialId'> & {
  readonly credential?: SourceCredentialInput | null;
};

export type SourceError =
  | 'forbidden'
  | 'not_found'
  | 'invalid_config'
  | 'credential_scope_mismatch'
  | 'duplicate'
  | 'conflict'
  | 'indeterminate'
  | 'activation_requires_registered_names'
  | 'has_packages'
  | 'has_history'
  | 'invalid_pattern'
  | 'proxy_source'
  | 'pattern_taken'
  | 'invalid_name';

export type SourceServiceResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings?: readonly SourceConfigProblem[] }
  | {
      readonly ok: false;
      readonly error: SourceError;
      readonly problems?: readonly SourceConfigProblem[];
    };

type WriteArgs = [ctx: OrgContext, actor: SourceActor, fence: MutationFence];

export type SourceDto = Pick<
  SourceRecord,
  | 'id'
  | 'projectId'
  | 'name'
  | 'ecosystem'
  | 'type'
  | 'url'
  | 'status'
  | 'removalPolicy'
  | 'pollIntervalSeconds'
  | 'lastSuccessAt'
> & {
  readonly hasCredential: boolean;
  readonly lastRemovalRefusal: RemovalRefusal | null;
  readonly removalAcceptanceArmed: boolean;
};

export type SourceListDto = SourceDto & { readonly attachedProjectCount?: number };

export interface SourceService {
  acceptRemoval(
    ...args: [...WriteArgs, id: string, call: ApiCall]
  ): Promise<SourceServiceResult<null>>;

  listRegisteredNames(
    ctx: OrgContext,
    actor: SourceActor,
    input: RegisteredNameListQuery,
  ): Promise<SourceServiceResult<RegisteredNamePage>>;
  /** Visibility preflight for a matching project actor with project:sources:write. */
  getVisible(
    ctx: OrgContext,
    actor: SourceActor,
    input: { readonly projectId: string; readonly sourceId: string },
  ): Promise<SourceServiceResult<SourceDto>>;
  list(
    ctx: OrgContext,
    actor: SourceActor,
    input: { readonly projectId?: string; readonly cursor: string | null; readonly limit: number },
  ): Promise<
    SourceServiceResult<{ readonly items: readonly SourceListDto[]; readonly next: string | null }>
  >;
  pause(...args: [...WriteArgs, id: string, call: ApiCall]): Promise<SourceServiceResult<null>>;
  create(
    ...args: [...WriteArgs, input: SourceCreateInput]
  ): Promise<SourceServiceResult<{ readonly id: string }>>;
  update(
    ...args: [...WriteArgs, id: string, input: SourceUpdateInput]
  ): Promise<SourceServiceResult<{ readonly id: string }>>;
  delete(...args: [...WriteArgs, id: string]): Promise<SourceServiceResult<null>>;
  resume(...args: [...WriteArgs, id: string]): Promise<SourceServiceResult<null>>;
  enable(...args: [...WriteArgs, id: string, call: ApiCall]): Promise<SourceServiceResult<null>>;
  addRegisteredName(
    ...args: [
      ...WriteArgs,
      input: { readonly sourceId: string; readonly pattern: string },
      call: ApiCall,
    ]
  ): Promise<SourceServiceResult<{ readonly id: string }>>;
  removeRegisteredName(
    ...args: [...WriteArgs, id: string, call: ApiCall]
  ): Promise<SourceServiceResult<{ readonly paused: boolean }>>;
  preview(
    ctx: OrgContext,
    actor: SourceActor,
    input: {
      readonly projectId: string;
      readonly ecosystem: 'composer' | 'npm';
      readonly name: string;
    },
  ): Promise<
    SourceServiceResult<{
      readonly candidates: readonly WinnerCandidate[];
      readonly winner: WinnerCandidate | null;
    }>
  >;
}

export interface SourceServiceDeps {
  readonly sources: Pick<
    SourceRepository,
    | 'create'
    | 'update'
    | 'get'
    | 'getVisible'
    | 'delete'
    | 'resume'
    | 'list'
    | 'countAttachedProjects'
    | 'pause'
    | 'acceptRemoval'
  >;
  readonly organizations: Pick<OrganizationRepository, 'get'>;
  readonly registeredNames: RegisteredNameRepository;
  readonly credentials: Pick<CredentialStore, 'prepare'>;
  readonly credentialRepository: Pick<CredentialRepository, 'get'>;
  readonly catalogue: Pick<CatalogueReader, 'previewWinners'>;
  readonly policy: OutboundPolicy;
  readonly providerAnchors: NewSource['providerAnchors'];
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
}

const fail = (error: SourceError): SourceServiceResult<never> => ({ ok: false, error });
const invalid = (field: string, message: string): SourceServiceResult<never> => ({
  ok: false,
  error: 'invalid_config',
  problems: [{ field, message }],
});

function sourceDto(source: SourceRecord): SourceDto {
  let url: string | null = null;
  if (source.url !== null) {
    try {
      const parsed = new URL(source.url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        const redacted = redactValue(source.url, 2048, 'url');
        if (redacted.ok) {
          // Scan decoded path material too; keep the sanitized URL's original escaping.
          const decoded = decodeURIComponent(redacted.value);
          const checked = redactValue(decoded, 2048, 'url');
          if (checked.ok && checked.value === new URL(decoded).href) url = redacted.value;
        }
      }
    } catch {
      // Invalid stored URLs have no public representation.
    }
  }
  return {
    id: source.id,
    projectId: source.projectId,
    name: source.name,
    ecosystem: source.ecosystem,
    type: source.type,
    url,
    status: source.status,
    removalPolicy: source.removalPolicy,
    pollIntervalSeconds: source.pollIntervalSeconds,
    lastSuccessAt: source.lastSuccessAt,
    hasCredential: source.credentialId !== null,
    lastRemovalRefusal: source.removalRefusal,
    removalAcceptanceArmed: source.removalAccepted,
  };
}

function sourceCursor(ctx: OrgContext, projectId: string | null, id: string): string {
  return btoa(encodeURIComponent(JSON.stringify([1, ctx.orgId, projectId, id])));
}

function cursorAfter(ctx: OrgContext, projectId: string | null, cursor: string): string {
  if (cursor.length > 4096) throw new TypeError('Invalid source cursor');
  const decoded: unknown = JSON.parse(decodeURIComponent(atob(cursor)));
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    decoded[0] !== 1 ||
    decoded[1] !== ctx.orgId ||
    decoded[2] !== projectId ||
    typeof decoded[3] !== 'string' ||
    decoded[3].length === 0 ||
    decoded[3].length > 256 ||
    sourceCursor(ctx, projectId, decoded[3]) !== cursor
  )
    throw new TypeError('Invalid source cursor');
  return decoded[3];
}

export function createSourceService(deps: SourceServiceDeps): SourceService {
  function permitted(ctx: OrgContext, who: SourceActor, projectId: string | null): boolean {
    if (who.kind === 'org') {
      return (
        projectId === null &&
        who.actor.kind === 'organization' &&
        who.actor.permissions.has('org:sources:write')
      );
    }
    return (
      who.actor.kind === 'project' &&
      who.actor.orgId === ctx.orgId &&
      who.actor.projectId === projectId &&
      who.actor.permissions.has('project:sources:write')
    );
  }

  function requireFence(who: SourceActor, fence: MutationFence): void {
    if (fence.userId !== who.actor.userId) {
      throw new TypeError('the mutation fence must belong to the acting user');
    }
  }

  function orgOnly(who: SourceActor): boolean {
    return (
      who.kind === 'org' &&
      who.actor.kind === 'organization' &&
      who.actor.permissions.has('org:sources:write')
    );
  }

  async function owned(
    ctx: OrgContext,
    who: SourceActor,
    id: string,
  ): Promise<SourceRecord | null> {
    const source = await deps.sources.get(ctx, id);
    return source !== null && source.projectId === (who.kind === 'org' ? null : who.actor.projectId)
      ? source
      : null;
  }

  function validateBounds(input: SourceUpdateInput): SourceServiceResult<never> | null {
    if (input.url != null && input.url.length > 2048)
      return invalid('url', 'is longer than 2048 characters');
    if (
      input.pollIntervalSeconds !== undefined &&
      (!Number.isSafeInteger(input.pollIntervalSeconds) || input.pollIntervalSeconds <= 0)
    ) {
      return invalid('pollIntervalSeconds', 'must be a positive safe integer');
    }
    if (
      input.retentionDaysOverride != null &&
      (!Number.isSafeInteger(input.retentionDaysOverride) || input.retentionDaysOverride < 0)
    ) {
      return invalid('retentionDaysOverride', 'must be null or a non-negative safe integer');
    }
    return null;
  }

  async function validateRetention(
    ctx: OrgContext,
    input: SourceUpdateInput,
  ): Promise<SourceServiceResult<never> | null> {
    if (input.retentionDaysOverride == null) return null;
    const organization = await deps.organizations.get(ctx);
    if (organization === null) return fail('not_found');
    return checkRetentionOverride(
      input.retentionDaysOverride,
      organization.settings.retentionRemovedUpstreamDays,
    )
      ? null
      : invalid('retentionDaysOverride', 'must not shorten organization retention');
  }

  function validate(
    input: Pick<NewSource, 'type' | 'ecosystem' | 'url' | 'configJson' | 'projectId'>,
    credential: SourceCredentialInput | null | undefined,
    hasCredential: boolean,
    linkedKind?: string,
    existingKind?: string,
  ) {
    if (input.configJson.length > 65536)
      return invalid('config', 'is longer than 65536 characters');
    let config: unknown;
    try {
      config = JSON.parse(input.configJson);
    } catch {
      return invalid('config', 'invalid');
    }
    if (
      typeof config === 'object' &&
      config !== null &&
      'distHosts' in config &&
      Array.isArray(config.distHosts) &&
      config.distHosts.length > 64
    ) {
      return invalid('distHosts', 'must be a list of up to 64 entries');
    }
    let url = input.url;
    if (credential !== undefined && credential !== null) {
      try {
        parseCredentialMaterial(credential.kind, credential.plaintext);
      } catch (error) {
        if (error instanceof CredentialError) return invalid('credential', 'invalid');
        throw error;
      }
    }
    const kind = linkedKind ?? credential?.kind;
    const githubKind = kind ?? existingKind;
    const github =
      input.type === 'vcs' &&
      typeof config === 'object' &&
      config !== null &&
      'provider' in config &&
      config.provider === 'github';
    if (
      (kind === 'github_app' && input.projectId !== null) ||
      (kind === 'ssh_key' && deps.policy.runtime !== 'node') ||
      (kind === 'query' && input.type !== 'composer_repository') ||
      (linkedKind !== undefined && (github ? kind !== 'github_app' : kind === 'github_app'))
    ) {
      return linkedKind === undefined
        ? invalid('credential', 'invalid')
        : fail('credential_scope_mismatch');
    }
    if (
      github &&
      githubKind === 'bearer' &&
      typeof config === 'object' &&
      config !== null &&
      'installationId' in config
    ) {
      return invalid('installationId', 'cannot be combined with a personal access token');
    }
    if (
      github &&
      githubKind !== undefined &&
      githubKind !== 'github_app' &&
      githubKind !== 'bearer'
    ) {
      return invalid('credential', 'github requires github_app or bearer');
    }
    if (
      github &&
      githubKind === 'github_app' &&
      typeof config === 'object' &&
      config !== null &&
      !('installationId' in config)
    ) {
      return invalid('installationId', 'is required with a GitHub App credential');
    }
    if (url !== null && input.type === 'composer_repository' && kind === 'query') {
      try {
        const parsed = new URL(url);
        parsed.search = '';
        // Preserve the caller's path spelling, including the absence of a trailing slash.
        url = url.split('?')[0] ?? parsed.href;
      } catch {
        return invalid('url', 'invalid');
      }
    }
    if (url !== null && !classifyUrl(url, deps.policy).ok)
      return invalid('url', 'denied_by_policy');
    if (
      input.type === 'vcs' &&
      typeof config === 'object' &&
      config !== null &&
      'provider' in config &&
      'repository' in config &&
      typeof config.repository === 'string'
    ) {
      if (config.provider === 'git' && !classifyUrl(config.repository, deps.policy).ok)
        return invalid('repository', 'denied_by_policy');
      if (config.provider === 'ssh' && deps.policy.runtime === 'node') {
        const match = config.repository.startsWith('ssh://')
          ? /^ssh:\/\/[^@/:]+@(\[[^\]/]*\]|[^/:[\]]+)(?::(\d{1,5}))?\/.+$/.exec(config.repository)
          : /^[^@/:]+@([^/:]+):.+$/.exec(config.repository);
        if (match !== null) {
          const verdict = classifyUrl(`https://${match[1]}:${match[2] ?? '22'}/`, deps.policy);
          // SSH permits public destinations on arbitrary ports, as the config parser does.
          if (!verdict.ok && verdict.reason !== 'port')
            return invalid('repository', 'denied_by_policy');
        }
      }
    }
    if (
      typeof config === 'object' &&
      config !== null &&
      'distHosts' in config &&
      Array.isArray(config.distHosts)
    ) {
      for (const host of config.distHosts as unknown[]) {
        if (
          typeof host === 'string' &&
          host.length <= 200 &&
          !classifyUrl(`https://${host}/`, deps.policy).ok
        ) {
          return invalid('distHosts', 'denied_by_policy');
        }
      }
    }
    const result = parseSourceConfig(input.type, input.ecosystem, url, input.configJson, {
      runtime: deps.policy.runtime,
      policy: deps.policy,
      hasCredential,
    });
    if (!result.ok)
      return { ok: false as const, error: 'invalid_config' as const, problems: result.problems };
    return {
      ok: true as const,
      value: { url, configJson: JSON.stringify(result.config) },
      warnings: result.warnings,
    };
  }

  function success<T>(value: T, warnings?: readonly SourceConfigProblem[]): SourceServiceResult<T> {
    for (const warning of warnings ?? []) {
      try {
        deps.log({ level: 'info', event: 'source.config.warning', field: warning.field });
      } catch {
        // A failing log sink cannot undo the persisted change.
      }
    }
    return warnings === undefined ? { ok: true, value } : { ok: true, value, warnings };
  }

  async function transition(
    ctx: OrgContext,
    who: SourceActor,
    fence: MutationFence,
    id: string,
    action: 'delete' | 'resume',
  ): Promise<SourceServiceResult<null>> {
    if (!permitted(ctx, who, who.kind === 'project' ? who.actor.projectId : null))
      return fail('forbidden');
    requireFence(who, fence);
    if ((await owned(ctx, who, id)) === null) return fail('not_found');
    const target = { id, providerAnchors: deps.providerAnchors };
    const answer = await deps.sources[action](ctx, fence, target);
    return answer === 'deleted' || answer === 'resumed' ? success(null) : fail(answer);
  }

  function mutationAudit(
    call: ApiCall,
    who: SourceActor,
    action: AuditAction,
    type: string,
    id: string,
    projectId: string | null = null,
  ) {
    const result = auditEvent({
      id: deps.ids.ulid(),
      now: new Date().toISOString(),
      action,
      actor: { type: 'user', id: who.actor.userId },
      context: call.audit,
      target: { type, id },
      projectId,
    });
    if (!result.ok) throw new TypeError('Invalid source audit event');
    return {
      audit: result.event,
      ...(call.idempotency === undefined ? {} : { idempotency: call.idempotency }),
    };
  }

  return {
    async acceptRemoval(ctx, who, fence, id, call) {
      if (!orgOnly(who) || who.kind !== 'org' || !who.actor.isOrganizationAdmin)
        return fail('forbidden');
      requireFence(who, fence);
      const source = await deps.sources.get(ctx, id);
      if (source === null) return fail('not_found');
      if (
        source.projectId !== null &&
        (await deps.sources.getVisible(ctx, {
          projectId: source.projectId,
          sourceId: id,
        })) === null
      )
        return fail('not_found');
      const refusal = source.removalRefusal;
      if (refusal === null || refusal.successful === 0 || source.removalAccepted)
        return fail('conflict');
      const event = auditEvent({
        id: deps.ids.ulid(),
        now: new Date().toISOString(),
        action: 'source.removal_accepted',
        actor: { type: 'user', id: who.actor.userId },
        context: call.audit,
        target: { type: 'source', id },
        projectId: source.projectId,
        changes: {
          source_id: { new: id },
          refused_at: { new: refusal.at },
          absent: { new: refusal.absent },
          listed: { new: refusal.listed },
          successful: { new: refusal.successful },
        },
      });
      if (!event.ok) throw new TypeError('Invalid source audit event');
      const answer = await deps.sources.acceptRemoval(ctx, fence, {
        id,
        refusal,
        audit: event.event,
        providerAnchors: deps.providerAnchors,
      });
      return answer === 'accepted' ? success(null) : fail(answer);
    },
    async listRegisteredNames(ctx, who, input) {
      if (
        who.kind === 'org'
          ? who.actor.kind !== 'organization' || !who.actor.permissions.has('org:sources:read')
          : who.actor.kind !== 'project' ||
            who.actor.orgId !== ctx.orgId ||
            !who.actor.permissions.has('project:sources:read')
      )
        return fail('forbidden');
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return invalid('limit', 'must be an integer from 1 to 100');
      const source =
        who.kind === 'org'
          ? await deps.sources.get(ctx, input.sourceId)
          : await deps.sources.getVisible(ctx, {
              projectId: who.actor.projectId,
              sourceId: input.sourceId,
            });
      if (source === null) return fail('not_found');
      if (
        who.kind === 'org' &&
        source.projectId !== null &&
        (await deps.sources.getVisible(ctx, {
          projectId: source.projectId,
          sourceId: input.sourceId,
        })) === null
      )
        return fail('not_found');
      return success(await deps.registeredNames.list(ctx, input));
    },
    async getVisible(ctx, who, input) {
      if (!permitted(ctx, who, input.projectId)) return fail('forbidden');
      const source = await deps.sources.getVisible(ctx, input);
      return source === null ? fail('not_found') : success(sourceDto(source));
    },
    async list(ctx, who, input) {
      const projectId = input.projectId ?? null;
      if (
        !who.actor.permissions.has(
          projectId === null ? 'org:sources:read' : 'project:sources:read',
        ) ||
        (who.kind === 'org'
          ? who.actor.kind !== 'organization'
          : who.actor.kind !== 'project' ||
            who.actor.orgId !== ctx.orgId ||
            who.actor.projectId !== projectId)
      )
        return fail('forbidden');
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return invalid('limit', 'must be an integer from 1 to 100');
      let after: string | null = null;
      if (input.cursor !== null) {
        try {
          after = cursorAfter(ctx, projectId, input.cursor);
        } catch {
          return invalid('cursor', 'invalid');
        }
      }
      const rows = await deps.sources.list(ctx, { projectId, after, limit: input.limit });
      const page = rows.slice(0, input.limit);
      const counts =
        projectId === null && who.kind === 'org' && page.length > 0
          ? await deps.sources.countAttachedProjects(ctx, {
              sourceIds: page.map((source) => source.id),
              userId: who.actor.userId,
              ...(who.servicePrincipalId === undefined
                ? {}
                : { servicePrincipalId: who.servicePrincipalId }),
              ...(who.restrictTo === undefined ? {} : { restrictTo: who.restrictTo }),
              allProjects:
                who.actor.isOrganizationAdmin || who.actor.permissions.has('project:read'),
              includeArchived: who.actor.isOrganizationAdmin,
              providerAnchors: deps.providerAnchors,
            })
          : null;
      const items = page.map((source) => ({
        ...sourceDto(source),
        ...(counts === null ? {} : { attachedProjectCount: counts.get(source.id) ?? 0 }),
      }));
      const last = items.at(-1);
      return success({
        items,
        next:
          rows.length > input.limit && last !== undefined
            ? sourceCursor(ctx, projectId, last.id)
            : null,
      });
    },
    async pause(ctx, who, fence, id, call) {
      if (!permitted(ctx, who, who.kind === 'project' ? who.actor.projectId : null))
        return fail('forbidden');
      requireFence(who, fence);
      const source = await owned(ctx, who, id);
      if (source === null) return fail('not_found');
      const answer = await deps.sources.pause(ctx, fence, {
        id,
        providerAnchors: deps.providerAnchors,
        ...mutationAudit(call, who, 'source.pause', 'source', id, source.projectId),
      });
      return answer === 'paused' ? success(null) : fail(answer);
    },
    async create(ctx, who, fence, input) {
      if (!permitted(ctx, who, input.projectId)) return fail('forbidden');
      requireFence(who, fence);
      const bounds = validateBounds(input);
      if (bounds !== null) return bounds;
      const retention = await validateRetention(ctx, input);
      if (retention !== null) return retention;
      if (input.credential != null && input.credentialId != null)
        return invalid('credential', 'give either a credential or a credentialId');
      const { credentialId, ...rest } = input;
      const linkedCredential =
        credentialId != null ? await deps.credentialRepository.get(ctx, credentialId) : null;
      if (credentialId != null && linkedCredential === null)
        return fail('credential_scope_mismatch');
      const validated = validate(
        input,
        input.credential,
        input.credential != null || credentialId != null,
        linkedCredential?.kind,
      );
      if (!validated.ok) return validated;
      const id = deps.ids.ulid();
      let credential: NewSource['credential'] = null;
      if (credentialId != null) {
        credential = { id: credentialId };
      } else if (input.credential != null) {
        const plaintext =
          typeof input.credential.plaintext === 'string'
            ? new TextEncoder().encode(input.credential.plaintext)
            : Uint8Array.from(input.credential.plaintext);
        try {
          credential = {
            ...(await deps.credentials.prepare(ctx, {
              kind: input.credential.kind,
              projectId: input.projectId,
              plaintext,
            })),
            projectId: input.projectId,
          };
        } finally {
          plaintext.fill(0);
        }
      }
      const answer = await deps.sources.create(ctx, fence, {
        ...rest,
        ...validated.value,
        id,
        credential,
        providerAnchors: deps.providerAnchors,
      });
      return answer === 'created' ? success({ id }, validated.warnings) : fail(answer);
    },
    async update(ctx, who, fence, id, input) {
      if (!permitted(ctx, who, who.kind === 'project' ? who.actor.projectId : null))
        return fail('forbidden');
      requireFence(who, fence);
      const bounds = validateBounds(input);
      if (bounds !== null) return bounds;
      const retention = await validateRetention(ctx, input);
      if (retention !== null) return retention;
      const source = await owned(ctx, who, id);
      if (source === null) return fail('not_found');
      if (!Object.values(input).some((value) => value !== undefined))
        return invalid('changes', 'must name one or more updatable source fields');
      const validated = validate(
        { ...source, ...input },
        input.credential,
        input.credential === undefined ? source.credentialId !== null : input.credential !== null,
        undefined,
        source.type === 'vcs' &&
          isGithubConfig(input.configJson ?? source.configJson) &&
          input.credential === undefined &&
          source.credentialId !== null
          ? (await deps.credentialRepository.get(ctx, source.credentialId))?.kind
          : undefined,
      );
      if (!validated.ok) return validated;
      let preparedCredential: SourceUpdate['preparedCredential'];
      let credentialId = source.credentialId;
      if (input.credential === null) credentialId = null;
      else if (input.credential !== undefined) {
        const plaintext =
          typeof input.credential.plaintext === 'string'
            ? new TextEncoder().encode(input.credential.plaintext)
            : Uint8Array.from(input.credential.plaintext);
        try {
          preparedCredential = await deps.credentials.prepare(ctx, {
            kind: input.credential.kind,
            projectId: source.projectId,
            plaintext,
          });
          credentialId = preparedCredential.id;
        } finally {
          plaintext.fill(0);
        }
      }
      const changes = { ...input };
      delete changes.credential;
      const answer = await deps.sources.update(ctx, fence, {
        id,
        changes: {
          ...changes,
          ...(input.url === undefined ? {} : { url: validated.value.url }),
          ...(input.configJson === undefined ? {} : { configJson: validated.value.configJson }),
          ...(input.credential === undefined ? {} : { credentialId }),
        },
        ...(preparedCredential === undefined ? {} : { preparedCredential }),
        providerAnchors: deps.providerAnchors,
      });
      return answer === 'updated' || answer === 'paused_for_reactivation'
        ? success({ id }, validated.warnings)
        : fail(answer);
    },
    delete: (ctx, who, fence, id) => transition(ctx, who, fence, id, 'delete'),
    resume: (ctx, who, fence, id) => transition(ctx, who, fence, id, 'resume'),
    async enable(ctx, who, fence, id, call) {
      if (!permitted(ctx, who, who.kind === 'project' ? who.actor.projectId : null))
        return fail('forbidden');
      requireFence(who, fence);
      const source = await owned(ctx, who, id);
      if (source === null) return fail('not_found');
      const answer = await deps.registeredNames.enable(ctx, fence, {
        id,
        providerAnchors: deps.providerAnchors,
        ...mutationAudit(call, who, 'source.resume', 'source', id, source.projectId),
      });
      return answer === 'enabled' || answer === 'already_enabled' ? success(null) : fail(answer);
    },
    async addRegisteredName(ctx, who, fence, input, call) {
      if (!orgOnly(who)) return fail('forbidden');
      requireFence(who, fence);
      if (!isValidPattern(input.pattern)) return fail('invalid_pattern');
      const id = deps.ids.ulid();
      const answer = await deps.registeredNames.add(ctx, fence, {
        ...input,
        id,
        ...mutationAudit(call, who, 'registered_name.add', 'registered_name', id),
        providerAnchors: deps.providerAnchors,
      });
      return answer === 'added' ? success({ id }) : fail(answer);
    },
    async removeRegisteredName(ctx, who, fence, id, call) {
      if (!orgOnly(who)) return fail('forbidden');
      requireFence(who, fence);
      const owner = await deps.registeredNames.owner(ctx, id);
      if (owner === null) return fail('not_found');
      const answer = await deps.registeredNames.remove(ctx, fence, {
        id,
        ...mutationAudit(call, who, 'registered_name.remove', 'registered_name', id),
        pauseAudit: mutationAudit(
          call,
          who,
          'source.pause',
          'source',
          owner.sourceId,
          owner.projectId,
        ).audit,
        providerAnchors: deps.providerAnchors,
      });
      return answer === 'removed' || answer === 'removed_and_paused'
        ? success({ paused: answer === 'removed_and_paused' })
        : fail(answer);
    },
    async preview(ctx, who, input) {
      if (
        !who.actor.permissions.has('project:sources:read') ||
        (who.kind === 'org'
          ? who.actor.kind !== 'organization'
          : who.actor.kind !== 'project' ||
            who.actor.orgId !== ctx.orgId ||
            who.actor.projectId !== input.projectId)
      ) {
        return fail('forbidden');
      }
      let key: string;
      try {
        key = packageKey(input.name, { ecosystem: input.ecosystem });
      } catch (error) {
        if (error instanceof PackageNameError) return fail('invalid_name');
        throw error;
      }
      const candidates = await deps.catalogue.previewWinners(ctx, {
        projectId: input.projectId,
        ecosystem: input.ecosystem,
        key,
      });
      return success({
        candidates,
        winner: candidates.find((candidate) => candidate.eligible) ?? null,
      });
    },
  };
}

function isGithubConfig(configJson: string): boolean {
  try {
    const config: unknown = JSON.parse(configJson);
    return (
      typeof config === 'object' &&
      config !== null &&
      'provider' in config &&
      config.provider === 'github'
    );
  } catch {
    return false;
  }
}
