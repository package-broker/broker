import { packageKey } from '../../catalogue/names.js';
import { isWorkflowFilename } from '../../registry/npm/oidc/claim-values.js';
import { NPM_IDENTITY_SCHEMAS } from './npm-identity-schemas.js';

export function trustedPublisherInput(value: unknown) {
  const input = NPM_IDENTITY_SCHEMAS.TrustedPublisherCreateBody.parse(value);
  packageKey(input.packageName, { ecosystem: 'npm' });
  if (
    (input.refPattern !== undefined &&
      (input.refPattern.length < 1 || !/^[A-Za-z0-9._/@:+?*-]+$/.test(input.refPattern))) ||
    /\p{Cc}/u.test(input.environment) ||
    new TextEncoder().encode(input.environment).length > 255
  )
    throw new TypeError('invalid_publisher_input');
  if (!isWorkflowFilename(input.workflow)) throw new TypeError('invalid_workflow');
  return {
    ...input,
    repository: input.repository.toLowerCase(),
    environment: input.environment.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
  };
}
