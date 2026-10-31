import { sha256Hex } from '../../auth/primitives.js';
import { isValidServicePrincipalName } from '../../authz/service-principal-name.js';
import { redactValue } from '../../audit/redact.js';

export async function trustedPublisherPrincipalName(
  repository: string,
  workflow: string,
  packageName: string,
  environment: string,
): Promise<string> {
  for (const part of [repository, workflow, packageName, environment]) {
    const cleaned = redactValue(part, 4096, 'name');
    if (/\p{Cc}/u.test(part) || !cleaned.ok || cleaned.value !== part)
      throw new TypeError('invalid_publisher_name');
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(environment))
    throw new TypeError('invalid_publisher_name');
  const hash = (
    await sha256Hex(JSON.stringify([repository, workflow, packageName, environment]))
  ).slice(0, 8);
  const prefix = `trusted:${repository}:${workflow}`;
  const name = `${Array.from(prefix).length <= 91 ? prefix : Array.from(prefix).slice(0, 90).join('') + '…'}~${hash}`;
  return isValidServicePrincipalName(name) ? name : `trusted~${hash}`;
}
