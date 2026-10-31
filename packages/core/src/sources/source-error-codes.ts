export const SOURCE_ERROR_CODES = [
  'network',
  'timeout',
  'http_error',
  'unauthorized',
  'rate_limited',
  'not_found',
  'invalid_response',
  'tag_limit_exceeded',
  'mass_absence',
  'too_large',
  'policy_denied',
  'credential_unavailable',
  'internal',
  'name_mismatch',
  'version_mismatch',
  'invalid_manifest',
  'unsupported_files_pattern',
  'invalid_packlist',
  'invalid_tarball',
  'archive_changed',
] as const;

export const NPM_PACK_SKIP_CODES = [
  'unsupported_files_pattern',
  'invalid_packlist',
  'invalid_tarball',
  'archive_changed',
] as const;
export type NpmPackSkipCode = (typeof NPM_PACK_SKIP_CODES)[number];
