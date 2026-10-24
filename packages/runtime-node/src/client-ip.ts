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

export function nodeClientIp(
  request: Request,
  remoteAddress: string | null,
  trustedProxy = false,
): string | null {
  if (!trustedProxy) return ipLiteral(remoteAddress);
  const candidate =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0];
  const forwarded =
    candidate === undefined ? forwardedIp(request.headers.get('forwarded')) : ipLiteral(candidate);
  return forwarded ?? ipLiteral(remoteAddress);
}
