import {
  definePlugin,
  type IdentityProvider,
  type PluginDefinition,
} from '@package-broker/core/plugin';
import {
  type CloudflareAccessConfig,
  createCloudflareAccessProvider,
} from './cloudflare-access.js';
import { checkEntries, isContainer } from './provider-checks.js';
import { type OidcConfig, createOidcProvider } from './oidc.js';
import { planProviders } from './planner.js';
import { providerPresentation } from './presentation.js';
import {
  MAX_RUNTIME_PROVIDERS as MAX_PROVIDERS,
  parseRuntimeProviders,
  RUNTIME_PROVIDERS_VARIABLE,
  type RuntimeProviders,
} from './runtime.js';

export type { CloudflareAccessConfig } from './cloudflare-access.js';
export type { OidcConfig } from './oidc.js';

export interface SsoOidcOptions {
  readonly providers?: readonly (CloudflareAccessConfig | OidcConfig)[];
  readonly runtimeProviders?: boolean;
}

function definition(
  extra: Pick<PluginDefinition, 'binds' | 'identityProviders' | 'identityDescriptor'>,
): PluginDefinition {
  return Object.freeze(
    definePlugin({
      id: 'sso-oidc',
      package: '@package-broker/plugin-sso-oidc',
      apiVersion: 3,
      platforms: Object.freeze(['cloudflare', 'node'] as const),
      capabilities: Object.freeze(['sso'] as const),
      ...extra,
    }),
  );
}

function fail(problems: readonly string[]): never {
  throw new TypeError(`invalid sso-oidc configuration: ${problems.join('; ')}`);
}

function warn(fields: Readonly<Record<string, unknown>>): void {
  try {
    console.warn(JSON.stringify({ event: 'sso.runtime_providers', ...fields }));
  } catch {
    // Diagnostics must not prevent provider construction.
  }
}

export default function ssoOidc(options: SsoOidcOptions = {}): PluginDefinition {
  if (!isContainer(options)) {
    return fail(['options must be an object']);
  }
  let runtimeProviders: unknown;
  try {
    runtimeProviders = options.runtimeProviders;
  } catch {
    return fail(['runtimeProviders must be readable']);
  }
  if (runtimeProviders !== undefined && typeof runtimeProviders !== 'boolean') {
    return fail(['runtimeProviders must be a boolean']);
  }
  let configured: unknown;
  let length = 0;
  let readable = true;
  try {
    configured = options.providers;
    if (Array.isArray(configured)) {
      length = (configured as unknown[]).length;
    }
  } catch {
    readable = false;
  }
  if (!readable) {
    return fail(['providers must be readable']);
  }
  if (configured !== undefined && !Array.isArray(configured)) {
    return fail(['providers must be an array']);
  }
  if (length === 0 && runtimeProviders !== true) {
    return definition({});
  }
  if (length > MAX_PROVIDERS) {
    return fail([`providers must hold at most ${MAX_PROVIDERS} entries`]);
  }

  const { accepted, rejected } = checkEntries(length, (index) => (configured as unknown[])[index]);
  if (rejected.length > 0) {
    return fail(rejected.flatMap((entry) => entry.problems));
  }

  return definition({
    binds: Object.freeze(['identity'] as const),
    identityDescriptor: Object.freeze({
      runtimeProviders: runtimeProviders === true,
      compiled: Object.freeze(
        accepted.map((c) =>
          Object.freeze({
            id: c.id,
            kind: c.kind,
            anchor: providerPresentation(c).trustAnchor,
          }),
        ),
      ),
    }),
    identityProviders: (ctx): readonly IdentityProvider[] => {
      let effective = accepted;
      if (runtimeProviders === true) {
        let runtime: RuntimeProviders;
        try {
          runtime = parseRuntimeProviders(ctx.env(RUNTIME_PROVIDERS_VARIABLE));
        } catch {
          runtime = { ...parseRuntimeProviders(undefined), documentProblem: 'unreadable' };
        }
        const plan = planProviders(accepted, runtime);
        effective = plan.effective;
        if (runtime.documentProblem !== null) warn({ documentProblem: runtime.documentProblem });
        for (const { index, id, codes } of runtime.rejected) warn({ index, id, codes });
        for (const key of ['overridden', 'suppressed', 'displaced', 'overflow'] as const) {
          for (const id of plan[key]) warn({ [key]: id });
        }
      }
      const providers: IdentityProvider[] = [];
      for (const config of effective) {
        try {
          providers.push(
            config.kind === 'oidc'
              ? createOidcProvider(config, ctx)
              : createCloudflareAccessProvider(config, ctx),
          );
        } catch (error) {
          if (accepted.includes(config)) throw error;
          warn({ id: config.id, code: 'construction_failed' });
        }
      }
      return providers;
    },
  });
}
