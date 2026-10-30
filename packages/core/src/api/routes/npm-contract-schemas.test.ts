import { describe, expect, it } from 'vitest';
import { npmPublishAccepted, publishRejectBody } from './publishes-schemas.js';
import { generateOpenApi } from '../openapi.js';

describe('npm schema contracts', () => {
  it('represents active and held publish responses', () => {
    expect(npmPublishAccepted.safeParse({ ok: true, id: '@scope/pkg@1.0.0', rev: 1 }).success).toBe(
      true,
    );
    expect(
      npmPublishAccepted.safeParse({
        ok: true,
        id: '@scope/pkg@1.0.0',
        held: { approval: true, scan: false },
        status: 'https://registry.example/_pb/publishes/id',
      }).success,
    ).toBe(true);
  });
  it('requires a bounded rejection reason', () => {
    expect(publishRejectBody.safeParse({ reason: '' }).success).toBe(false);
    expect(publishRejectBody.safeParse({ reason: 'x'.repeat(1001) }).success).toBe(false);
    expect(publishRejectBody.safeParse({ reason: 'policy' }).success).toBe(true);
  });
  it('registers the future contract schemas without installing routes', () => {
    const doc = generateOpenApi([], { title: 'test', version: 'test' });
    expect(doc.components.schemas).toHaveProperty('NpmPublishAccepted');
    expect(doc.components.schemas).toHaveProperty('PublishApproval');
    expect(doc.components.schemas).toHaveProperty('PackageAccessRequest');
    expect(doc.components.schemas).toHaveProperty('NpmLoginStart');
    expect(doc.components.schemas).toHaveProperty('TrustedPublisher');
    expect(doc.paths).toEqual({});
  });
});
