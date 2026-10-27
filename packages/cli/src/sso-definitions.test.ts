import { parseRuntimeProviders } from '@package-broker/plugin-sso-oidc/definitions';
import { expect, it } from 'vitest';

it('parses a runtime provider document through the public definitions export', () => {
  const provider = {
    id: 'corp',
    kind: 'oidc',
    issuer: 'https://idp.example.com',
    clientId: 'broker',
    policy: { verifiedDomains: ['example.com'], autoJoin: false },
  };
  const result = parseRuntimeProviders(JSON.stringify([provider]));
  expect(result.documentProblem).toBeNull();
  expect(result.rejected).toEqual([]);
  expect(result.accepted).toMatchObject([{ id: 'corp' }]);
});
