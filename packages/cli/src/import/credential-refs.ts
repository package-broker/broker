import { isCredentialValue } from '@package-broker/core/audit/redact';

const ENV_REF = /^env:[A-Z_][A-Z0-9_]{0,127}$/;
const TOKEN_ENV_PREFIXES = ['AKIA', 'ASIA', 'GHP_', 'GHO_', 'GHS_', 'GITHUB_PAT_', 'XOX', 'GLPAT'];
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

export function isCredentialReference(ref: string): boolean {
  if (/\p{Cc}/u.test(ref)) return false;
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    return (
      ENV_REF.test(ref) &&
      !TOKEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
      !isCredentialValue(name)
    );
  }
  if (!ref.startsWith('file:')) return false;
  const path = ref.slice(5);
  return (
    ABSOLUTE_PATH.test(path) &&
    !path.split(/[\\/]/).includes('..') &&
    Buffer.byteLength(path) <= 1024 &&
    !isCredentialValue(path)
  );
}
