import { isIpLiteral } from '@package-broker/core/audit/actions';

// Workers ingress supplies this header; forwarded headers are caller controlled.
export function clientIpOf(request: Request): string | null {
  const candidate = request.headers.get('cf-connecting-ip')?.trim() ?? null;
  return candidate !== null && isIpLiteral(candidate) ? candidate : null;
}
