import { isReservedProviderId, isValidProviderId } from './port.js';

export const ENV_PREFIX = 'PB_IDP_';
export const PROVIDER_SECRET_SUFFIXES: readonly string[] = Object.freeze([
  'CLIENT_ID',
  'CLIENT_SECRET',
]);

export function providerSecretName(providerId: string, suffix: string): string {
  if (!isValidProviderId(providerId) || isReservedProviderId(providerId)) {
    throw new RangeError('provider id is not valid for a secret name');
  }
  if (!PROVIDER_SECRET_SUFFIXES.includes(suffix)) {
    throw new RangeError(`secret suffix must be one of ${PROVIDER_SECRET_SUFFIXES.join(', ')}`);
  }
  return `${ENV_PREFIX}${providerId.toUpperCase().replaceAll('-', '_')}_${suffix}`;
}
