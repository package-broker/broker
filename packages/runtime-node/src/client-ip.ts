import { isIpLiteral } from '@package-broker/core/audit/actions';

function ipLiteral(value: string | null | undefined): string | null {
  const ip = value?.trim();
  return ip !== undefined && isIpLiteral(ip) ? ip : null;
}

function forwardedParameters(value: string): string[] | null {
  const parameters: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quoted && character === '\\') {
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === ';' || character === ',')) {
      parameters.push(value.slice(start, index));
      if (character === ',') return parameters;
      start = index + 1;
    }
  }
  if (quoted) return null;
  parameters.push(value.slice(start));
  return parameters;
}

function forwardedIp(value: string | null): string | null {
  if (value === null) return null;
  const parameter = forwardedParameters(value)?.find((part) => /^\s*for\s*=/i.test(part));
  const match = parameter?.match(/^\s*for\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^"\s]+))\s*$/i);
  const candidate = match?.[1]?.replace(/\\(.)/g, '$1') ?? match?.[2];
  const bracketed = candidate?.match(/^\[([0-9a-f:.]+)\](?::[0-9]+)?$/i);
  if (bracketed !== undefined && bracketed !== null) {
    const ip = bracketed[1];
    return ip !== undefined && ip.includes(':') && isIpLiteral(ip) ? ip : null;
  }
  return ipLiteral(candidate);
}

export type TrustedProxy =
  | { readonly kind: 'none' }
  | { readonly kind: 'cloudflare' }
  | { readonly kind: 'xff'; readonly hops: number }
  | { readonly kind: 'legacy' };

export const MAX_TRUSTED_PROXY_HOPS = 10;

export const TRUSTED_PROXY_RULE = `must be 0, cloudflare or xff:<n> with n from 1 to ${MAX_TRUSTED_PROXY_HOPS}`;

export const TRUSTED_PROXY_DEPRECATION = Object.freeze({
  level: 'warn',
  event: 'config.deprecated',
  key: 'PB_TRUSTED_PROXY',
});

const NO_TRUSTED_PROXY: TrustedProxy = Object.freeze({ kind: 'none' });
const LEGACY_TRUSTED_PROXY: TrustedProxy = Object.freeze({ kind: 'legacy' });

/** Parses `PB_TRUSTED_PROXY`; null means the value is not accepted. */
export function parseTrustedProxy(value: string | undefined): TrustedProxy | null {
  if (value === undefined || value === '0') return NO_TRUSTED_PROXY;
  if (value === '1') return LEGACY_TRUSTED_PROXY;
  if (value === 'cloudflare') return Object.freeze({ kind: 'cloudflare' });
  const hops = /^xff:([1-9][0-9]?)$/.exec(value)?.[1];
  if (hops === undefined || Number(hops) > MAX_TRUSTED_PROXY_HOPS) return null;
  return Object.freeze({ kind: 'xff', hops: Number(hops) });
}

function legacyClientIp(request: Request): string | null {
  const candidate =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0];
  return candidate === undefined
    ? forwardedIp(request.headers.get('forwarded'))
    : ipLiteral(candidate);
}

function forwardedForHop(request: Request, hops: number): string | null {
  if (!Number.isInteger(hops) || hops < 1 || hops > MAX_TRUSTED_PROXY_HOPS) return null;
  const header = request.headers.get('x-forwarded-for');
  if (header === null) return null;
  const entries = header.split(',');
  return entries.length < hops ? null : ipLiteral(entries[entries.length - hops]);
}

function headerClientIp(request: Request, trustedProxy: TrustedProxy): string | null {
  switch (trustedProxy.kind) {
    case 'none':
      return null;
    case 'cloudflare':
      return ipLiteral(request.headers.get('cf-connecting-ip'));
    case 'xff':
      return forwardedForHop(request, trustedProxy.hops);
    case 'legacy':
      return legacyClientIp(request);
    default:
      return null;
  }
}

/** `true` is the deprecated `PB_TRUSTED_PROXY=1` behaviour. */
export function nodeClientIp(
  request: Request,
  remoteAddress: string | null,
  trustedProxy: TrustedProxy | boolean = NO_TRUSTED_PROXY,
): string | null {
  const policy: TrustedProxy =
    trustedProxy === true
      ? LEGACY_TRUSTED_PROXY
      : trustedProxy === false
        ? NO_TRUSTED_PROXY
        : trustedProxy;
  return headerClientIp(request, policy) ?? ipLiteral(remoteAddress);
}

/** Admission never trusts client-chosen headers in deprecated legacy mode. */
export function nodeAdmissionIp(
  request: Request,
  remoteAddress: string | null,
  trustedProxy: TrustedProxy | boolean = NO_TRUSTED_PROXY,
): string | null {
  if (trustedProxy === true || (typeof trustedProxy === 'object' && trustedProxy.kind === 'legacy'))
    return ipLiteral(remoteAddress);
  return nodeClientIp(request, remoteAddress, trustedProxy);
}
