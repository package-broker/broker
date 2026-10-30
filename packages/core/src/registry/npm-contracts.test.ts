import { describe, expect, expectTypeOf, it } from 'vitest';
import { type RegistryConfigInput } from './registry-config.js';
import { PERMISSIONS, DEFAULT_ROLES } from '../authz/permissions.js';
import { AUDIT_ACTIONS, AUDIT_FIELDS } from '../audit/actions.js';
import { API_ERROR_CODES } from '../api/response.js';

describe('npm shared contract names', () => {
  it('declares publish inputs without resolving their runtime behavior yet', () => {
    type Caps = NonNullable<RegistryConfigInput['caps']>;
    expectTypeOf<Caps['publishBodyBytes']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Caps['publishTarballBytes']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Caps['publishMetadataBytes']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NonNullable<RegistryConfigInput['publish']>['requireLicense']>().toEqualTypeOf<
      boolean | undefined
    >();
  });
  it('declares publishing permissions and the publisher default role', () => {
    expect(PERMISSIONS).toContainEqual(
      expect.objectContaining({ name: 'org:packages:publish', sessionOnly: false }),
    );
    expect(PERMISSIONS).toContainEqual(
      expect.objectContaining({ name: 'org:packages:approve', sessionOnly: true }),
    );
    expect(PERMISSIONS).toContainEqual(expect.objectContaining({ name: 'org:packages:read' }));
    expect(DEFAULT_ROLES).toContainEqual(
      expect.objectContaining({
        key: 'organization_publisher',
        permissions: ['org:read', 'org:packages:publish'],
      }),
    );
  });
  it('declares audited publish actions and stable refusals', () => {
    for (const name of [
      'package.publish',
      'publish.approve',
      'publish.reject',
      'publish.expire',
      'publish.scan',
      'token.workload_issue',
      'package.access_request',
      'package.access_decide',
    ]) {
      expect(AUDIT_ACTIONS).toContain(name);
    }
    expect(AUDIT_FIELDS).toHaveProperty('package.publish', [
      'package',
      'version',
      'hold_approval',
      'hold_scan',
      'integrity',
      'size_bytes',
      'source',
    ]);
    expect(API_ERROR_CODES).toHaveProperty('version_exists', {
      status: 409,
      message: 'This package version already exists',
    });
  });
});
