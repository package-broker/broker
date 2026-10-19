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
  | { readonly kind: 'org'; readonly actor: ActorContext }
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

export type SourceServiceResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings?: readonly SourceConfigProblem[] }
  | {
      readonly ok: false;
      readonly error: string;
      readonly problems?: readonly SourceConfigProblem[];
    };

type WriteArgs = [ctx: OrgContext, actor: SourceActor, fence: MutationFence];
export interface SourceService {
  create(
    ...args: [...WriteArgs, input: SourceCreateInput]
  ): Promise<SourceServiceResult<{ readonly id: string }>>;
  update(
    ...args: [...WriteArgs, id: string, input: SourceUpdateInput]
  ): Promise<SourceServiceResult<{ readonly id: string }>>;
  delete(...args: [...WriteArgs, id: string]): Promise<SourceServiceResult<null>>;
  resume(...args: [...WriteArgs, id: string]): Promise<SourceServiceResult<null>>;
  enable(...args: [...WriteArgs, id: string]): Promise<SourceServiceResult<null>>;
  addRegisteredName(
    ...args: [...WriteArgs, input: { readonly sourceId: string; readonly pattern: string }]
  ): Promise<SourceServiceResult<{ readonly id: string }>>;
  removeRegisteredName(...args: [...WriteArgs, id: string]): Promise<SourceServiceResult<null>>;
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
  readonly sources: Pick<SourceRepository, 'create' | 'update' | 'get' | 'delete' | 'resume'>;
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

const fail = (error: string): SourceServiceResult<never> => ({ ok: false, error });
const invalid = (field: string, message: string): SourceServiceResult<never> => ({
  ok: false,
  error: 'invalid_config',
  problems: [{ field, message }],
});

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
      return { ok: false as const, error: 'invalid_config', problems: result.problems };
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
    action: 'delete' | 'resume' | 'enable',
  ): Promise<SourceServiceResult<null>> {
    if (!permitted(ctx, who, who.kind === 'project' ? who.actor.projectId : null))
      return fail('forbidden');
    requireFence(who, fence);
    if ((await owned(ctx, who, id)) === null) return fail('not_found');
    const target = { id, providerAnchors: deps.providerAnchors };
    const answer =
      action === 'enable'
        ? await deps.registeredNames.enable(ctx, fence, target)
        : await deps.sources[action](ctx, fence, target);
    return ['deleted', 'resumed', 'enabled', 'already_enabled'].includes(answer)
      ? success(null)
      : fail(answer);
  }

  return {
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
    enable: (ctx, who, fence, id) => transition(ctx, who, fence, id, 'enable'),
    async addRegisteredName(ctx, who, fence, input) {
      if (!orgOnly(who)) return fail('forbidden');
      requireFence(who, fence);
      const id = deps.ids.ulid();
      const answer = await deps.registeredNames.add(ctx, fence, {
        ...input,
        id,
        providerAnchors: deps.providerAnchors,
      });
      return answer === 'added' ? success({ id }) : fail(answer);
    },
    async removeRegisteredName(ctx, who, fence, id) {
      if (!orgOnly(who)) return fail('forbidden');
      requireFence(who, fence);
      const answer = await deps.registeredNames.remove(ctx, fence, {
        id,
        providerAnchors: deps.providerAnchors,
      });
      return answer === 'removed' || answer === 'removed_and_paused' ? success(null) : fail(answer);
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
