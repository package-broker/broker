import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../sources/policy-fetch.js';
import { NpmPackumentError } from './npm/packument.js';
import {
  isSnapshotGone,
  isUpstreamFailure,
  pendingValidators,
  safeValidator,
  upstreamForm,
} from './fill-shared.js';
import { SnapshotCorruptError } from './snapshot.js';

describe('fill-shared', () => {
  it('derives the upstream form from the source type', () => {
    expect(upstreamForm('npmjs_proxy')).toBe('npm-packument');
    expect(upstreamForm('npm_registry')).toBe('npm-packument');
    expect(upstreamForm('packagist_proxy')).toBe('composer-p2');
    expect(upstreamForm('composer_repository', 'composer-v1-provider')).toBe(
      'composer-v1-provider',
    );
  });

  it('drops validators that are not valid header values', () => {
    expect(safeValidator('"e"')).toBe('"e"');
    expect(safeValidator('bad\nvalue')).toBeNull();
    expect(safeValidator(undefined)).toBeNull();
  });

  it('keeps both Composer forms and one npm form', () => {
    expect(
      Object.keys(pendingValidators({ 'composer-p2': { etag: '"a"' } }, 'composer-p2')),
    ).toEqual(['composer-p2', 'composer-p2-dev']);
    expect(pendingValidators({ 'npm-full': { etag: '"a"' } }, 'npm-packument')).toEqual({
      'npm-packument': { etag: '"a"', lastModified: null, contentSha256: null },
    });
  });

  it('classifies failures', () => {
    expect(isUpstreamFailure(new UpstreamError('network'))).toBe(true);
    expect(isUpstreamFailure(new Error('x'))).toBe(false);
    expect(isSnapshotGone(new SnapshotCorruptError())).toBe(true);
    expect(isSnapshotGone(new NpmPackumentError('snapshot_gone'))).toBe(true);
    expect(isSnapshotGone(new Error('x'))).toBe(false);
  });
});
