import type { AuditEvent } from '../audit/actions.js';
import type { ApiCall, IdempotencyRecord } from '../api/idempotency.js';
import type { VisibilityService } from '../catalogue/visibility-service.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ActorContext } from '../authz/administration.js';
import type { ProjectActor } from '../authz/project-actor.js';
import { MetadataError, normalizeVersionMetadata } from '../catalogue/metadata.js';
import type { Statement } from './port.js';
import {
  ABSENCE_MIN_NOT_FOUND,
  ABSENCE_MIN_SPAN_MS,
  CATALOGUE_KEY_LIST_MAX,
  CATALOGUE_PAGE_MAX,
  CATALOGUE_SEARCH_MAX,
  CATALOGUE_SYNC_CHUNK_VERSIONS,
  CATALOGUE_SYNC_VERSIONS_PER_CALL,
  CATALOGUE_WINNER_KEYS_MAX,
  catalogueWriteGuard,
  validateLimit,
} from './catalogue.js';
import type {
  CatalogueReader,
  CatalogueVersion,
  CatalogueWriteGuard,
  CatalogueWriter,
  DistTarget,
  FetchDescriptor,
  KeyClassification,
  ListedPackage,
  PackageResolution,
  PackageVisibility,
  PackageVisibilityPort,
  ResolveDistQuery,
  ResolvedPackage,
  SyncResult,
  VersionInput,
  VersionLookup,
  WinnerCandidate,
  WinnerClassification,
  VisibilityStore,
} from './catalogue.js';

type Keys<T> = keyof T & string;
type Credentialish =
  | 'user'
  | 'userId'
  | 'token'
  | 'tokenId'
  | 'actor'
  | 'principal'
  | 'credential'
  | 'credentialId'
  | 'password'
  | 'secret'
  | 'authorization'
  | 'email';
type NoCredential<T> = Extract<Keys<T>, Credentialish>;
type Visible = Extract<PackageVisibility, { kind: 'visible' }>;

describe('write guard brand', () => {
  it('is not satisfied by a plain statement array', () => {
    expectTypeOf<Statement[]>().not.toMatchTypeOf<CatalogueWriteGuard>();
    const plain: readonly Statement[] = [];
    // @ts-expect-error a plain Statement[] is not a CatalogueWriteGuard
    const guard: CatalogueWriteGuard = plain;
    expect(guard).toBe(plain);
  });

  it('freezes a copy of the statements', () => {
    const statements: Statement[] = [{ sql: 'SELECT 1', params: [] }];
    const guard = catalogueWriteGuard(statements);
    statements.push({ sql: 'SELECT 2', params: [] });
    expect(guard).toHaveLength(1);
    expect(Object.isFrozen(guard)).toBe(true);
  });
});

describe('result types carry no principal or credential', () => {
  it('ResolvedPackage has the resolution header and no credential-ish key', () => {
    expectTypeOf<ResolvedPackage>().toMatchTypeOf<{
      projectId: string;
      packageId: string;
      sourceId: string;
      ecosystem: 'composer' | 'npm';
      key: string;
      rev: number;
      modifiedAt: string;
      createdAt: string;
      listingComplete: boolean;
      cacheEpoch: string | null;
    }>();
    expectTypeOf<NoCredential<ResolvedPackage>>().toEqualTypeOf<never>();
    expectTypeOf<NoCredential<PackageResolution>>().toEqualTypeOf<never>();
    expectTypeOf<NoCredential<VersionLookup>>().toEqualTypeOf<never>();
    expectTypeOf<NoCredential<CatalogueVersion>>().toEqualTypeOf<never>();
    expectTypeOf<NoCredential<ListedPackage>>().toEqualTypeOf<never>();
    expectTypeOf<NoCredential<Visible>>().toEqualTypeOf<never>();
    expectTypeOf<NoCredential<Exclude<PackageVisibility, Visible>>>().toEqualTypeOf<never>();
  });

  it('FetchDescriptor and DistTarget hold digests and no credential', () => {
    expectTypeOf<FetchDescriptor>().toMatchTypeOf<{
      sourceRef: string | null;
      upstreamDistUrl: string | null;
      distType: 'zip' | 'tar' | 'tgz' | null;
      composerShasum: string | null;
      npmIntegrity: string | null;
      npmShasum: string | null;
    }>();
    expectTypeOf<NoCredential<FetchDescriptor>>().toEqualTypeOf<never>();
    expectTypeOf<NoCredential<DistTarget>>().toEqualTypeOf<never>();
    expectTypeOf<NoCredential<NonNullable<DistTarget['blob']>>>().toEqualTypeOf<never>();
    expectTypeOf<DistTarget['fetch']>().toEqualTypeOf<FetchDescriptor>();
    expectTypeOf<DistTarget['status']>().toEqualTypeOf<'active' | 'removed_upstream'>();
  });

  it('serves no quarantined, tombstoned or yanked version', () => {
    expectTypeOf<CatalogueVersion['status']>().toEqualTypeOf<'active' | 'removed_upstream'>();
  });
});

describe('reader contract', () => {
  it('resolves dist by version with expect, or by id and revision, never by digest', () => {
    const base = { projectId: 'p', ecosystem: 'composer', key: 'a/b' } as const;
    expectTypeOf({
      ...base,
      by: 'version',
      versionNormalized: '1.0.0.0',
    } as const).toMatchTypeOf<ResolveDistQuery>();
    expectTypeOf({
      ...base,
      by: 'version',
      versionNormalized: '1.0.0.0',
      expect: { versionId: 'v', revision: 2 },
    } as const).toMatchTypeOf<ResolveDistQuery>();
    expectTypeOf({
      ...base,
      by: 'id',
      versionId: 'v',
      revision: 2,
    } as const).toMatchTypeOf<ResolveDistQuery>();
    expectTypeOf({
      ...base,
      by: 'id',
      versionId: 'v',
    } as const).not.toMatchTypeOf<ResolveDistQuery>();
    expectTypeOf({
      ...base,
      by: 'sha256',
      sha256: 'x',
    } as const).not.toMatchTypeOf<ResolveDistQuery>();
  });

  it('classifies closure keys into three classes and winners by source type', () => {
    expectTypeOf<KeyClassification['class']>().toEqualTypeOf<
      'proxy_admissible' | 'attachable' | 'not_available'
    >();
    expectTypeOf<
      NonNullable<WinnerClassification['winner']>['sourceType']
    >().toMatchTypeOf<string>();
    expectTypeOf<NoCredential<WinnerCandidate>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<Keys<WinnerCandidate>, 'visible'>>().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<Keys<CatalogueReader>, 'visibleKeys' | 'closureEdges'>
    >().toEqualTypeOf<never>();
  });

  it('visibility resolves to exactly three outcomes for a project actor only', () => {
    type Outcome = Awaited<ReturnType<PackageVisibilityPort['resolve']>>;
    expectTypeOf<Outcome['kind']>().toEqualTypeOf<'visible' | 'proxy_admissible' | 'absent'>();
    expectTypeOf<Parameters<PackageVisibilityPort['resolve']>[0]>().toEqualTypeOf<ProjectActor>();
    expectTypeOf<ActorContext>().not.toMatchTypeOf<ProjectActor>();
    expectTypeOf<ProjectActor>().not.toMatchTypeOf<ActorContext>();
    expectTypeOf<ProjectActor['userId']>().toEqualTypeOf<string>();
  });
});

describe('writer contract', () => {
  it('job-guarded quarantine takes only integrity reasons; admin transitions are fenced', () => {
    type JobQuarantine = Parameters<CatalogueWriter['quarantine']>[2]['reason'];
    expectTypeOf<JobQuarantine>().toEqualTypeOf<'digest_mismatch' | 'manifest_conflict'>();
    expectTypeOf<Extract<Keys<CatalogueWriter>, 'tombstone'>>().toEqualTypeOf<never>();
    expectTypeOf<
      Parameters<VisibilityStore['quarantineVersion']>[2]['reason']
    >().toEqualTypeOf<'admin_quarantine'>();
    expectTypeOf<
      Parameters<VisibilityStore['tombstoneVersion']>[2]['reason']
    >().toEqualTypeOf<'admin_tombstone'>();
    expectTypeOf<Parameters<VisibilityStore['tombstoneVersion']>[1]>().toEqualTypeOf<
      Parameters<VisibilityStore['attachSource']>[1]
    >();
  });

  it('package absence takes only the package id; the 404 evidence is checked in the batch', () => {
    expectTypeOf<Parameters<CatalogueWriter['markPackageAbsent']>[2]>().toEqualTypeOf<{
      readonly packageId: string;
    }>();
  });

  it('SyncResult reports every outcome and the executed statements', () => {
    expectTypeOf<SyncResult>().toMatchTypeOf<{
      inserted: number;
      updated: number;
      unchanged: number;
      conflicts: readonly string[];
      refused: readonly { version: string }[];
      skippedTags: readonly string[];
      statements: number;
    }>();
  });

  it('VersionInput nullability matches the version columns', () => {
    expectTypeOf<VersionInput['sourceRef']>().toEqualTypeOf<string | null>();
    expectTypeOf<VersionInput['distType']>().toEqualTypeOf<'zip' | 'tar' | 'tgz' | null>();
    expectTypeOf<VersionInput['upstreamReleasedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<VersionInput['license']>().toEqualTypeOf<string | null>();
  });
});

describe('validateLimit', () => {
  it('returns an in-range integer', () => {
    expect(validateLimit(1, CATALOGUE_PAGE_MAX)).toBe(1);
    expect(validateLimit(200, CATALOGUE_PAGE_MAX)).toBe(200);
    expect(validateLimit(50, CATALOGUE_SEARCH_MAX)).toBe(50);
    expect(validateLimit(1000, CATALOGUE_KEY_LIST_MAX)).toBe(1000);
  });

  it('refuses zero, negatives, non-integers, non-numbers and values above the maximum', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 201, '5', null, undefined]) {
      expect(() => validateLimit(bad, CATALOGUE_PAGE_MAX)).toThrow(TypeError);
    }
    expect(() => validateLimit(51, CATALOGUE_SEARCH_MAX)).toThrow(TypeError);
    expect(() => validateLimit(1001, CATALOGUE_KEY_LIST_MAX)).toThrow(TypeError);
    expect(() => validateLimit(201, CATALOGUE_WINNER_KEYS_MAX)).toThrow(TypeError);
  });

  it('exports the design budgets', () => {
    expect(CATALOGUE_PAGE_MAX).toBe(200);
    expect(CATALOGUE_SEARCH_MAX).toBe(50);
    expect(CATALOGUE_KEY_LIST_MAX).toBe(1000);
    expect(CATALOGUE_WINNER_KEYS_MAX).toBe(200);
    expect(CATALOGUE_SYNC_CHUNK_VERSIONS).toBe(50);
    expect(CATALOGUE_SYNC_VERSIONS_PER_CALL).toBe(50);
    expect(ABSENCE_MIN_NOT_FOUND).toBe(2);
    expect(ABSENCE_MIN_SPAN_MS).toBe(3_600_000);
  });
});

describe('normalized metadata writer boundary', () => {
  const literal = {
    json: '{}',
    license: null,
    deprecatedMessage: null,
    composerShasum: null,
    npmIntegrity: null,
  };

  it('rejects structural metadata in syncPackage', () => {
    type Metadata = Parameters<CatalogueWriter['syncPackage']>[2]['versions'][number]['metadata'];
    // @ts-expect-error metadata must come from the normaliser
    const metadata: Metadata = literal;
    expect(metadata).toBe(literal);
  });

  it('rejects structural metadata in VersionInput', () => {
    // @ts-expect-error metadata must come from the normaliser
    const metadata: VersionInput['metadata'] = literal;
    expect(metadata).toBe(literal);
  });

  it('rejects replacing normalized json through a spread', () => {
    const normalized = normalizeVersionMetadata('composer', {});
    // @ts-expect-error replacement json must come from the normaliser
    const metadata: VersionInput['metadata'] = { ...normalized, json: '{}' };
    expect(metadata.json).toBe('{}');
  });

  it('rejects assigning normalized json', () => {
    const metadata = normalizeVersionMetadata('composer', {});
    // @ts-expect-error normalized fields are readonly
    metadata.json = '{}';
    // @ts-expect-error even normalized json cannot replace a readonly field
    metadata.json = normalizeVersionMetadata('composer', {}).json;
    expect(metadata.json).toBe('{}');
  });

  it('normaliser rejects userinfo credentials', () => {
    const url = new URL('https://dist.example/package.zip');
    url.username = 'fixture-user';
    expect(() => normalizeVersionMetadata('composer', { dist: { url: url.href } })).toThrow(
      MetadataError,
    );
  });

  it('normaliser rejects credential parameters', () => {
    const url = new URL('https://dist.example/package.tgz');
    url.searchParams.set('token', 'fixture-value');
    expect(() => normalizeVersionMetadata('npm', { dist: { tarball: url.href } })).toThrow(
      MetadataError,
    );
  });
});

it('requires audit on the ordering port and ApiCall only on its service method', () => {
  type Order = Parameters<VisibilityStore['setOrder']>[2];
  expectTypeOf<Order['audit']>().toEqualTypeOf<AuditEvent>();
  expectTypeOf<Order['idempotency']>().toEqualTypeOf<IdempotencyRecord | undefined>();
  expectTypeOf<Order['sourceIds']>().toEqualTypeOf<readonly string[]>();
  expectTypeOf<Parameters<VisibilityService['setOrder']>[3]>().toEqualTypeOf<ApiCall>();
  expectTypeOf<Parameters<VisibilityService['setOrder']>['length']>().toEqualTypeOf<4>();
  type Other = Exclude<keyof VisibilityService, 'setOrder'>;
  expectTypeOf<Parameters<VisibilityService[Other]>['length']>().toEqualTypeOf<3>();
});
