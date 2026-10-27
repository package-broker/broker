export const DEFAULT_ACCESS_DISPLAY_NAME = 'Cloudflare Access';

export function providerPresentation(
  config: { readonly id: string; readonly displayName?: string | undefined } & (
    | { readonly kind: 'oidc'; readonly issuer: string }
    | { readonly kind: 'cloudflare-access'; readonly teamDomain: string; readonly audience: string }
  ),
): { displayName: string; trustAnchor: string } {
  return {
    displayName:
      config.displayName ?? (config.kind === 'oidc' ? config.id : DEFAULT_ACCESS_DISPLAY_NAME),
    trustAnchor:
      config.kind === 'oidc'
        ? `oidc:${config.issuer}`
        : `access:${config.teamDomain}/${config.audience}`,
  };
}
