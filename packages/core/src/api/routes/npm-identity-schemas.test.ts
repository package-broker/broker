import { expect, it } from 'vitest';
import { assertRepresentable, toJsonSchema } from '../json-schema.js';
import { NPM_IDENTITY_SCHEMAS } from './npm-identity-schemas.js';
import { trustedPublisherInput } from './trusted-publishers-input.js';

it('exports npm identity schemas through the strict OpenAPI exporter', () => {
  for (const [name, schema] of Object.entries(NPM_IDENTITY_SCHEMAS)) {
    expect(() => assertRepresentable(schema, name)).not.toThrow();
  }
  expect(toJsonSchema(NPM_IDENTITY_SCHEMAS.TrustedPublisherCreateBody, 'input')).toMatchObject({
    properties: { packageName: { 'x-pb-npm-package-name': true } },
  });
  expect(toJsonSchema(NPM_IDENTITY_SCHEMAS.NpmLoginStartBody, 'input')).toMatchObject({
    properties: { hostname: { 'x-pb-max-utf8-bytes': 253 } },
  });
});

it.each([
  'Widget',
  '~widget',
  '.widget',
  '_widget',
  'node_modules',
  'favicon.ico',
  '@scope',
  'a/b',
])('retains canonical package name validation for trusted publisher input: %s', (packageName) => {
  expect(() =>
    trustedPublisherInput({
      packageName,
      repository: 'owner/repo',
      workflow: 'publish.yml',
      environment: '',
    }),
  ).toThrow();
});
