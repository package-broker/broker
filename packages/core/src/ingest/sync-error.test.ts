import { expect, it } from 'vitest';
import { GitRefsError } from '../sources/git/refs.js';
import { UpstreamError } from '../sources/policy-fetch.js';
import { sourceErrorCode } from './sync-error.js';

it('preserves the dedicated tag ceiling code separately from malformed responses', () => {
  expect(sourceErrorCode(Object.assign(new Error('fixed'), { code: 'tag_limit_exceeded' }))).toBe(
    'tag_limit_exceeded',
  );
  expect(sourceErrorCode(new GitRefsError('bad_response', 'invalid secret-bearing ref'))).toBe(
    'invalid_response',
  );
});

it('returns only stable codes and never uses upstream text', () => {
  expect(sourceErrorCode(new Error('https://user:secret@example.com/private'))).toBe('internal');
  expect(sourceErrorCode(new UpstreamError('http_status', 429))).toBe('rate_limited');
  expect(sourceErrorCode(new UpstreamError('refused'))).toBe('policy_denied');
  expect(sourceErrorCode(new UpstreamError('timeout'))).toBe('timeout');
});
