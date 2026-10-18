import { generateOpenApi } from '@package-broker/core/api/openapi';
import { openApiRoute } from '@package-broker/core/api/openapi-route';
import { expect, it } from 'vitest';

it('imports OpenAPI helpers through core API subpaths from the CLI package', () => {
  const document = generateOpenApi([], { title: 'Package Broker', version: '2.0.0' });
  expect(document.openapi).toBe('3.1.0');
  expect(openApiRoute(document)).toMatchObject({ method: 'GET', path: '/_pb/openapi.json' });
});
