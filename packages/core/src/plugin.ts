import type { OrganizationRepository } from './db/organization.js';
import type { OrgContext } from './db/port.js';
import type { IdentityProviderFactory, VerifiedIdentity } from './identity/port.js';
import type { Clock } from './ids.js';
import type { JobDefinition } from './platform/jobs.js';

export type OrganizationReader = Pick<OrganizationRepository, 'get'>;

export const SUPPORTED_PLUGIN_API = [2, 3] as const;

export type Platform = 'cloudflare' | 'node';

export type PortName =
  | 'database'
  | 'blob'
  | 'cache'
  | 'job'
  | 'session'
  | 'identity'
  | 'secrets'
  | 'observability'
  | 'source';

export const PLUGIN_BINDABLE_PORTS = ['source', 'identity'] as const satisfies readonly PortName[];

export interface PluginApi {
  readonly apiVersion: number;
}

export interface PluginDefinition extends PluginApi {
  /** Not 'core'. */
  readonly id: string;
  readonly package: string;
  readonly platforms: readonly Platform[];
  readonly dependsOn?: readonly string[];
  readonly capabilities?: readonly string[];
  /** Ports this plugin supplies; runtime-owned ports cannot be bound. 'identity' needs identityProviders. */
  readonly binds?: readonly (typeof PLUGIN_BINDABLE_PORTS)[number][];
  /** Required when `binds` contains 'identity', rejected otherwise. */
  readonly identityProviders?: IdentityProviderFactory;
  readonly migrations?: { readonly dir: string };
  /** Synchronous and pure: declares routes, hooks and jobs. Runs in pb build and at kernel boot. */
  readonly register?: (registry: PluginRegistry) => void;
  /** Runs once per kernel after every plugin registered. Receives ports, never adapters. */
  readonly init?: (ports: PluginPorts) => void | Promise<void>;
}

export interface PluginRegistry {
  route(route: RouteDefinition): void;
  hook<K extends keyof HookMap>(name: K, handler: HookMap[K]): void;
  job(definition: JobDefinition): void;
}

export type RouteBoundary = 'none' | 'organization' | 'project' | 'self' | 'package';

export interface RouteDefinition {
  /** HEAD is served by GET routes, same authorization. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  /** null = public. */
  readonly permission: string | null;
  /**
   * Required when permission is set; omitted means 'none' on a public route. 'self' is an
   * authenticated-session route with no permission. 'package' is reserved.
   */
  readonly boundary?: RouteBoundary;
  /** Default true; false requires permission null. */
  readonly needsOrg?: boolean;
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
