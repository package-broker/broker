import { SOURCE_ERROR_CODES } from '../sources/source-error-codes.js';
import { UpstreamError } from '../sources/policy-fetch.js';
import { GitRefsError } from '../sources/git/refs.js';
import type { SourceErrorCode } from '../db/source.js';

export function sourceErrorCode(error: unknown): SourceErrorCode {
  if (error instanceof GitRefsError) {
    return error.code === 'too_large' ? 'too_large' : 'invalid_response';
  }
  if (error instanceof UpstreamError) {
    switch (error.code) {
      case 'refused':
        return 'policy_denied';
      case 'timeout':
        return 'timeout';
      case 'too_large':
        return 'too_large';
      case 'network':
        return 'network';
      case 'http_status':
        if (error.status === 401 || error.status === 403) return 'unauthorized';
        if (error.status === 429) return 'rate_limited';
        if (error.status === 404) return 'not_found';
        return 'http_error';
    }
  }
  if (error instanceof Error && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string' && SOURCE_ERROR_CODES.includes(code as SourceErrorCode))
      return code as SourceErrorCode;
    if (
      ['invalid', 'invalid_response', 'bad_response', 'snapshot_changed'].includes(
        typeof code === 'string' ? code : '',
      )
    )
      return 'invalid_response';
  }
  return 'internal';
}
