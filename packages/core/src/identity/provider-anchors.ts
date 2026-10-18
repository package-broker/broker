import type { OrgContext } from '../db/port.js';
import { isValidDomain } from './policy.js';
import type { ProviderMap } from './providers.js';

export interface ConfiguredProviderAnchor {
  readonly provider: string;
  readonly anchor: string;
  /** True exactly when `emailAuthoritativeDomains` is non-empty. */
  readonly emailAuthoritative: boolean;
  /** As configured; an identity's e-mail domain must equal one of them for its e-mail to count. */
  readonly emailAuthoritativeDomains: readonly string[];
}

export interface ProviderAnchorReader {
  anchors(ctx: OrgContext): Promise<readonly ConfiguredProviderAnchor[]>;
}

export function providerAnchorsOf(providers: ProviderMap): readonly ConfiguredProviderAnchor[] {
  const anchors: ConfiguredProviderAnchor[] = [];
  for (const provider of providers.values()) {
    const domains = Object.freeze([...(provider.policy.emailAuthoritativeDomains ?? [])]);
    if (!domains.every((domain) => typeof domain === 'string' && isValidDomain(domain))) {
      throw new TypeError('emailAuthoritativeDomains must be lowercase ASCII domain names');
    }
    anchors.push(
      Object.freeze({
        provider: provider.id,
        anchor: provider.trustAnchor,
        emailAuthoritative: domains.length > 0,
        emailAuthoritativeDomains: domains,
      }),
    );
  }
  return Object.freeze(anchors);
}

/** Provider configuration is fixed per process; a rebind is compared in SQL on every lookup. */
export function createProviderAnchorReader(providers: ProviderMap): ProviderAnchorReader {
  const anchors = providerAnchorsOf(providers);
  return Object.freeze({ anchors: () => Promise.resolve(anchors) });
}
