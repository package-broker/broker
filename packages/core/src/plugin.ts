import type { $ZodType as ZodType } from 'zod/v4/core';
import type { OrganizationRepository } from './db/organization.js';
import type { OrgContext } from './db/port.js';
import type { IdentityProviderFactory, VerifiedIdentity } from './identity/port.js';
import type { Clock } from './ids.js';
import type { BlobStore } from './platform/blob.js';
import type { Cache } from './platform/cache.js';
import { PlatformUnavailableError } from './platform/errors.js';
import type { JobDefinition, Jobs } from './platform/jobs.js';
import type { Observability } from './platform/observability.js';
import type { GithubAppMaterial } from './sources/credentials.js';
import type { UpstreamCredential } from './sources/policy-fetch.js';
import type { ProviderSource, SourceProvider } from './sources/provider.js';

export { PlatformUnavailableError } from './platform/errors.js';

export {
  base64urlDecode,
  base64urlEncode,
  constantTimeEqual,
  randomToken,
  sha256Hex,
} from './auth/primitives.js';
export { packageKey } from './catalogue/names.js';
export { normalizeEmail, domainPolicyProblems } from './identity/policy.js';
export { providerFieldProblems } from './identity/provider-fields.js';
export {
  isReservedProviderId,
  isValidProviderId,
  isValidSubject,
  isValidTrustAnchor,
} from './identity/port.js';
export type {
  DomainPolicy,
  IdentityContext,
  IdentityFailure,
  IdentityProvider,
  IdentityProviderFactory,
  IdentityResult,
  LoginStateData,
  StartResult,
  VerifiedIdentity,
} from './identity/port.js';
export { providerSecretName } from './identity/secret-name.js';
export type { Clock } from './ids.js';
export { SnapshotCorruptError } from './ingest/snapshot.js';
export { versionsFromRefs } from './registry/composer/version-rules.js';
export { readFileAtRefs } from './sources/git/fetch.js';
export { lsRefs } from './sources/git/refs.js';
export type { DiscoveryCandidate, PlanEntry, SkipReason } from './sources/plan.js';
export { GITHUB_API_VERSION, UpstreamError } from './sources/policy-fetch.js';
export type { PolicyFetch, UpstreamCredential, UpstreamResponse } from './sources/policy-fetch.js';
export { createPackageDescription, snapshotRef } from './sources/provider.js';
export type {
  ProviderContext,
  ProviderSource,
  SourceProvider,
  VersionCandidate,
} from './sources/provider.js';

export type OrganizationReader = Pick<OrganizationRepository, 'get'>;

export const SUPPORTED_PLUGIN_API = [3, 4] as const;

export type Platform = 'cloudflare' | 'node';

export type PortName =
  'database' | 'blob' | 'cache' | 'job' | 'identity' | 'observability' | 'source';

export const PLUGIN_BINDABLE_PORTS = ['source', 'identity'] as const satisfies readonly PortName[];

export interface SourceProviderContext {
  readonly runtime: 'docker' | 'cloudflare';
  /** Opens an opaque, organization-scoped App binding for discovery before a source exists. */
  discoveryCredential?(
    org: OrgContext,
    credentialId: string,
    installationId: string,
  ): Promise<UpstreamCredential | null>;
  /** Resolves an organization-owned GitHub App installation; unknown bindings return null. */
  tokensFor<T>(
    org: OrgContext,
    source: ProviderSource | UpstreamCredential,
    create: (
      app: Pick<GithubAppMaterial, 'appId' | 'privateKeyPem'>,
      installationId: string,
      credentialId?: string,
    ) => T,
  ): Promise<T | null>;
}

export type SourceProviderFactory = (context?: SourceProviderContext) => readonly SourceProvider[];

export interface PluginApi {
  readonly apiVersion: number;
}

export interface IdentityDescriptor {
  readonly runtimeProviders: boolean;
  readonly compiled: readonly {
    readonly id: string;
    readonly kind: 'oidc' | 'cloudflare-access';
    readonly anchor: string;
    /**
     * Absent means the compiled provider's domain policy is unknown.
     * Lists contain at most 100 unique lowercase domains; verifiedDomains is nonempty,
     * and emailAuthoritativeDomains, when supplied, is a subset of verifiedDomains.
     */
    readonly policy?: {
      readonly verifiedDomains: readonly string[];
      readonly emailAuthoritativeDomains?: readonly string[];
    };
  }[];
}

export interface PluginDefinition extends PluginApi {
  /** Not 'core'. */
  readonly id: string;
  readonly package: string;
  readonly platforms: readonly Platform[];
  readonly dependsOn?: readonly string[];
  readonly capabilities?: readonly string[];
  /** Ports this plugin supplies; runtime-owned ports cannot be bound. 'identity' needs identityProviders, 'source' needs sourceProviders. */
  readonly binds?: readonly (typeof PLUGIN_BINDABLE_PORTS)[number][];
  /** Required when `binds` contains 'identity', rejected otherwise. */
  readonly identityProviders?: IdentityProviderFactory;
  /** Static description of the identity providers this plugin builds; no secrets. */
  readonly identityDescriptor?: IdentityDescriptor;
  /** Required when `binds` contains 'source', rejected otherwise. Needs apiVersion 3. */
  readonly sourceProviders?: SourceProviderFactory;
  readonly publishPolicy?: PublishPolicyDefinition;
  readonly migrations?: { readonly dir: string };
  /** Synchronous and pure: declares routes, hooks and jobs. Runs in pb build and at kernel boot. */
  readonly register?: (registry: PluginRegistry) => void;
  /** Runs once per kernel after every plugin registered. Receives ports, never adapters. */
  readonly init?: (ports: PluginPorts) => void | Promise<void>;
}

export interface PublishInspection {
  readonly signal: AbortSignal;
  readonly name: string;
  readonly version: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly integrity: string;
  readonly sizeBytes: number;
  openTarball(): Promise<ReadableStream<Uint8Array>>;
}

export interface PublishPolicyVerdict {
  readonly verdict: 'allow' | 'deny';
  readonly reason?: string;
}

export interface PublishPolicyDefinition {
  readonly id: string;
  /** Honour input.signal by stopping inspection and cancelling outstanding I/O when aborted.
   * Workers start persisted scans on the next cron tick.
   */
  inspect(ctx: OrgContext, input: PublishInspection): Promise<PublishPolicyVerdict>;
}

export interface PluginRegistry {
  route(route: RouteDefinition): void;
  hook<K extends keyof HookMap>(name: K, handler: HookMap[K]): void;
  job(definition: JobDefinition): void;
}

export type RouteBoundary =
  'none' | 'organization' | 'project' | 'self' | 'package' | 'authenticated';

export type PackageEcosystem = 'composer' | 'npm';

export interface PackageRouteBinding {
  readonly ecosystem: PackageEcosystem;
  /** Returns the raw package name from the route parameters; null means the request names no package. */
  readonly name: (params: Readonly<Record<string, string>>) => string | null;
  /** Default false: an admissible but unseen package is not fetched for this route. */
  readonly fetchOnAdmission?: boolean;
}

export interface ApiSlot {
  readonly exempt?: never;
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly params?: ZodType;
  readonly query?: ZodType;
  readonly body?: ZodType;
  readonly responses: Record<number, ZodType | null>;
  readonly mcp?: boolean;
}

export interface RouteDefinition {
  /** HEAD is served by GET routes, same authorization. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  /** null = public. */
  readonly permission: string | null;
  /**
   * Required when permission is set; omitted means 'none' on a public route. 'self' is an
   * authenticated-session route with no permission. 'package' needs a registered package
   * resolver, `package`, :project in the path and project:packages:read or write.
   */
  readonly boundary?: RouteBoundary;
  /** Required when boundary is 'package', rejected otherwise. */
  readonly package?: PackageRouteBinding;
  /** Default true; false requires permission null. */
  readonly needsOrg?: boolean;
  /**
   * Project boundary only. Lets the route resolve an archived project the caller already holds
   * permissions on; the permission check is unchanged and every route without it answers 404 for
   * an archived project.
   */
  readonly allowArchived?: true;
  readonly api?: ApiSlot | { exempt: string };
  readonly handler: (ctx: RequestContext) => Promise<Response> | Response;
}

export interface Principal {
  readonly kind: 'user' | 'service' | 'customer';
  readonly id: string;
}

export interface RequestContext {
  readonly request: Request;
  readonly requestId: string;
  /** null only when needsOrg is false. */
  readonly org: OrgContext | null;
  /** null on public routes. */
  readonly principal: Principal | null;
  readonly projectId: string | null;
  readonly params: Readonly<Record<string, string>>;
  readonly ports: PluginPorts;
}

export interface PluginPorts {
  readonly organizations: OrganizationReader;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  /** Absent when platform services are disabled; read it through requirePlatformPorts. */
  readonly platform?: PlatformPorts;
}

export interface PlatformPorts {
  readonly blob: BlobStore;
  readonly cache: Cache;
  readonly jobs: Jobs;
  readonly observability: Observability;
}

export function requirePlatformPorts(ports: PluginPorts): PlatformPorts {
  if (ports.platform === undefined || ports.platform === null) {
    throw new PlatformUnavailableError();
  }
  return ports.platform;
}

export interface AccessCheckInput {
  readonly org: OrgContext;
  readonly principal: Principal;
  readonly permission: string;
  readonly projectId: string | null;
}

/** Deny-only (ADR-004): there is no allow value; undefined passes. */
export type AccessCheckResult = { readonly deny: true; readonly reason?: string } | undefined;

export interface AuthResolveIdentityInput {
  readonly org: OrgContext;
  readonly identity: VerifiedIdentity;
  readonly userId: string | null;
}

export interface AuthMapGroupsInput {
  readonly org: OrgContext;
  readonly provider: string;
  readonly groups: readonly string[];
}

/** Narrow-only: `keep` must be a subset of the groups passed in; undefined keeps them all. */
export type MapGroupsResult = { readonly keep: readonly string[] } | undefined;

export interface HookMap {
  'access.check': (input: AccessCheckInput) => AccessCheckResult | Promise<AccessCheckResult>;
  'auth.resolveIdentity': (
    input: AuthResolveIdentityInput,
  ) => AccessCheckResult | Promise<AccessCheckResult>;
  'auth.mapGroups': (input: AuthMapGroupsInput) => MapGroupsResult | Promise<MapGroupsResult>;
}

export function definePlugin<const T extends PluginDefinition>(
  definition: T & Record<Exclude<keyof T, keyof PluginDefinition>, never>,
): T {
  return definition;
}

export { npmVcsDescription, parseNpmVcsManifest } from './ingest/vcs/npm-adapter.js';
export { npmVersionsFromRefs } from './registry/npm/version-rules.js';
