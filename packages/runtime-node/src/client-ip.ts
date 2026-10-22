import { isIP } from 'node:net';

export function nodeClientIp(
  request: Request,
  remoteAddress: string | null,
  trustedProxy = false,
): string | null {
  const candidate = trustedProxy
    ? (request.headers.get('cf-connecting-ip') ??
      request.headers.get('x-forwarded-for')?.split(',')[0] ??
      remoteAddress)
    : remoteAddress;
  const ip = candidate?.trim();
  return ip !== undefined && /^[0-9a-f:.]+$/i.test(ip) && isIP(ip) !== 0 ? ip : null;
}
