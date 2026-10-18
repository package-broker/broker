import { describe, expect, it } from 'vitest';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { versionInsertStatements } from './catalogue-write-version-insert.js';
import { versionUpdateStatements } from './catalogue-write-version-update.js';

function normalizedFixture() {
  return normalizeVersionMetadata('composer', { name: 'a/b', version: '1.0.0' });
}

const literal = {
  json: '{}',
  license: null,
  deprecatedMessage: null,
  composerShasum: null,
  npmIntegrity: null,
};

describe('normalized metadata version writers', () => {
  it('rejects structural metadata in versionInsertStatements', () => {
    type Metadata = Parameters<typeof versionInsertStatements>[2]['versions'][number]['metadata'];
    // @ts-expect-error metadata must come from the normaliser
    const metadata: Metadata = literal;
    expect(metadata).toBe(literal);
    const normalized: Metadata = normalizedFixture();
    expect(normalized.json).toContain('"name":"a/b"');
  });

  it('rejects structural metadata in versionUpdateStatements', () => {
    type Metadata = Parameters<typeof versionUpdateStatements>[2]['versions'][number]['metadata'];
    // @ts-expect-error metadata must come from the normaliser
    const metadata: Metadata = literal;
    expect(metadata).toBe(literal);
    const normalized: Metadata = normalizedFixture();
    expect(normalized.json).toContain('"name":"a/b"');
  });
});
