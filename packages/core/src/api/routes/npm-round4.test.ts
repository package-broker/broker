import { describe, expect, it } from 'vitest';
import { PUBLISH_SCHEMAS as publishes } from './publishes-schemas.js';
import { PACKAGE_ACCESS_REQUEST_SCHEMAS as access } from './package-access-requests-schemas.js';
import { NPM_IDENTITY_SCHEMAS as identity } from './npm-identity-schemas.js';
import { generateOpenApi } from '../openapi.js';

describe('npm reviewed schemas', () => {
  it('splits approval and rejection and bounds UTF-8 reasons', () => {
    const schemas = { ...publishes, ...access } as Record<
      string,
      { safeParse(value: unknown): { success: boolean } }
    >;
    for (const prefix of ['Publish', 'PackageAccess']) {
      const approve = schemas[`${prefix}ApproveBody`];
      const reject = schemas[`${prefix}RejectBody`];
      expect(approve?.safeParse({}).success).toBe(true);
      expect(reject?.safeParse({}).success).toBe(false);
      for (const schema of [approve, reject]) {
        expect(schema?.safeParse({ reason: 'é'.repeat(500) }).success).toBe(true);
        expect(schema?.safeParse({ reason: 'é'.repeat(501) }).success).toBe(false);
      }
      expect(reject?.safeParse({ reason: '' }).success).toBe(false);
    }
  });
  it('accepts empty login input and ignores client extensions', () => {
    expect(identity.NpmLoginStartBody.parse(undefined)).toEqual({});
    expect(identity.NpmLoginStartBody.parse({ hostname: 'cli', create: true, extra: 1 })).toEqual({
      hostname: 'cli',
      create: true,
    });
    expect(identity.NpmLoginStartBody.safeParse({ hostname: 'x'.repeat(254) }).success).toBe(false);
    expect(identity.NpmLoginStartBody.safeParse({ hostname: 'é'.repeat(126) }).success).toBe(true);
    expect(identity.NpmLoginStartBody.safeParse({ hostname: 'é'.repeat(127) }).success).toBe(false);
    expect(identity.NpmLoginStartBody.safeParse({ create: 'true' }).success).toBe(false);
  });
  it('bounds trusted publisher configuration', () => {
    const valid = {
      packageName: '@scope/pkg',
      repository: 'owner/name',
      workflow: 'publish.yaml',
      environment: '',
      refPattern: 'refs/heads/main',
    };
    const schema = identity.TrustedPublisherCreateBody;
    expect(schema.safeParse(valid).success).toBe(true);
    for (const [field, value] of Object.entries({
      packageName: 'x'.repeat(215),
      repository: 'owner',
      workflow: '../publish.yml',
      environment: 'x'.repeat(256),
      refPattern: 'x'.repeat(256),
    })) {
      expect(schema.safeParse({ ...valid, [field]: value }).success, field).toBe(false);
    }
    expect(schema.safeParse({ ...valid, repository: 'a/' + 'b'.repeat(139) }).success).toBe(false);
    for (const [field, value] of Object.entries({
      packageName: 'pkg\n',
      repository: 'owner/name\n',
      workflow: 'publish.yml\n',
    }))
      expect(schema.safeParse({ ...valid, [field]: value }).success, field).toBe(false);
    for (const workflow of ['publish.txt', 'x'.repeat(252) + '.yml'])
      expect(schema.safeParse({ ...valid, workflow }).success).toBe(false);
    expect(
      schema.safeParse({
        ...valid,
        packageName: 'x'.repeat(214),
        workflow: 'x'.repeat(251) + '.yml',
        repository: 'a/' + 'b'.repeat(138),
        environment: 'x'.repeat(255),
        refPattern: 'x'.repeat(255),
      }).success,
    ).toBe(true);
  });
  it('registers display fields, confirmation reads and opaque cursors', () => {
    const doc = generateOpenApi([], { title: 'test', version: 'test' });
    const schemas = doc.components.schemas as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    for (const [name, fields] of Object.entries({
      PublishApproval: [
        'packageName',
        'version',
        'sourceName',
        'requestedBy',
        'decidedBy',
        'project',
      ],
      PackageAccessRequest: ['packageName', 'requestedBy', 'decidedBy', 'project'],
      TrustedPublisher: ['servicePrincipalName', 'createdByName'],
      NpmLoginConfirmation: ['project', 'cliHostname', 'sourceIp', 'createdAt', 'expiresAt'],
      NpmLoginConfirmResponse: ['ok'],
    })) {
      for (const field of fields) expect(schemas[name]?.properties).toHaveProperty(field);
    }
    for (const query of [publishes.PublishListQuery, access.PackageAccessRequestListQuery]) {
      expect(query.safeParse({ cursor: 'opaque:cursor==', limit: '50' }).success).toBe(true);
      expect(query.safeParse({ cursor: 'x'.repeat(512) }).success).toBe(true);
      expect(query.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
    }
    for (const name of ['PublishListQuery', 'PackageAccessRequestListQuery']) {
      expect(schemas[name]?.properties?.cursor).toMatchObject({ type: 'string', maxLength: 512 });
      expect(schemas[name]?.properties?.cursor).not.toHaveProperty('pattern');
    }
  });
});
