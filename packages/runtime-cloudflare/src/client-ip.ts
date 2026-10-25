import { isIpLiteral } from '@package-broker/core/audit/actions';

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export function clientIpOf(request: Request): string | null {
  const candidate =
    nonEmpty(request.headers.get('cf-connecting-ip')) ??
    nonEmpty(request.headers.get('x-forwarded-for')?.split(',')[0] ?? null);
  return candidate !== null && isIpLiteral(candidate) ? candidate : null;
}
