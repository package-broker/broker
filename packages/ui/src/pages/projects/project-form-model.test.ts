import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../api.js';
import { ProjectForm } from './project-form.js';
import {
  capNotice,
  changeName,
  changeSlug,
  LOWER_CAP_NOTICE,
  projectBody,
  PROJECT_SLUG_PATTERN,
  serverFieldErrors,
  SLUG_RULE,
  suggestedSlug,
  useSuggestedSlug,
  validateDraft,
  type ProjectDraft,
} from './project-form-model.js';
const draft: ProjectDraft = { name: '', slug: '', manualSlug: false, tokenMaxScope: 'read' };

describe('project draft', () => {
  it.each([
    ['FastWhiteCat', 'fastwhitecat'],
    ['  Fast & white / cat! ', 'fast-white-cat'],
    ['a'.repeat(65), 'a'.repeat(64)],
    ['a'.repeat(63) + ' cat', 'a'.repeat(63)],
    ['猫', ''],
  ])('suggests a permanent slug from %s', (name, expected) => {
    expect(suggestedSlug(name)).toBe(expected);
  });
  it('stops suggesting after manual edits and resumes on request', () => {
    const automatic = changeName(draft, 'FastWhiteCat');
    expect(automatic.slug).toBe('fastwhitecat');
    const manual = changeSlug(automatic, 'custom');
    const renamed = changeName(manual, 'Other name');
    expect(renamed.slug).toBe('custom');
    const resumed = useSuggestedSlug(renamed);
    expect(resumed.slug).toBe('other-name');
    expect(changeName(resumed, 'Next').slug).toBe('next');
    expect(changeName(changeSlug(resumed, ''), 'Name').slug).toBe('');
  });
  it('pins the mirrored slug pattern to the core source', () => {
    const source = readFileSync(
      new URL('../../../../core/src/db/organization.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain(`export const ORG_SLUG_PATTERN = ${PROJECT_SLUG_PATTERN.toString()};`);
  });
  it.each(['a', '0', 'a--b', 'a'.repeat(64)])('accepts valid slug %s', (slug) => {
    expect(validateDraft({ ...draft, name: 'Name', slug })).toEqual({});
  });
  it.each(['', '-a', 'a-', 'A', 'a b', 'a_b', 'a'.repeat(65)])(
    'rejects invalid slug %s with exact copy',
    (slug) => {
      expect(validateDraft({ ...draft, name: 'Name', slug }).slug).toBe(SLUG_RULE);
    },
  );
  it('validates names by code points and explains names without an ASCII slug', () => {
    expect(validateDraft(draft).name).toBe('Enter a project name.');
    expect(validateDraft({ ...draft, name: ' ' }).name).toBe('Enter a project name.');
    expect(validateDraft({ ...draft, name: 'a'.repeat(101) }).name).toBe(
      'Use 100 characters or fewer.',
    );
    expect(validateDraft({ ...draft, name: '😀'.repeat(100), slug: 'ok' })).toEqual({});
    for (const character of ['\n', '\u200b', '\u2028', '\u2029', '\ud800']) {
      expect(validateDraft({ ...draft, name: `a${character}` }).name).toBe(
        'Use a name without control or formatting characters.',
      );
    }
    expect(validateDraft(changeName(draft, '猫')).slug).toBe(
      'Enter a project slug using lowercase letters, numbers or hyphens.',
    );
  });
  it('sends an explicit read cap and omits approval on create and update', () => {
    const filled = changeName(draft, 'FastWhiteCat');
    expect(projectBody(filled, false)).toEqual({
      name: 'FastWhiteCat',
      slug: 'fastwhitecat',
      tokenMaxScope: 'read',
    });
    expect(projectBody(filled, true)).toEqual({ name: 'FastWhiteCat', tokenMaxScope: 'read' });
  });
  it('explains lowering, raising and unchanged caps', () => {
    expect(capNotice('full', 'read')).toBe(LOWER_CAP_NOTICE);
    expect(capNotice('write', 'read')).toBe(LOWER_CAP_NOTICE);
    expect(capNotice('read', 'full')).toBe(
      'Existing tokens may regain access if their scope and permissions allow it.',
    );
    expect(capNotice('full', 'full')).toBeNull();
  });
});
const failure = (code: 'duplicate' | 'conflict' | 'invalid_request'): ApiResult<unknown> => ({
  ok: false,
  code,
  status: 400,
  details: [],
  request: { method: 'POST', path: '/_pb/projects' },
});
it('maps only identifiable field refusals and never invents a reserved-slug error', () => {
  expect(serverFieldErrors(failure('duplicate'), false)).toEqual({
    slug: 'This project slug is already in use. Choose another.',
  });
  expect(serverFieldErrors(failure('duplicate'), true)).toEqual({});
  expect(serverFieldErrors(failure('conflict'), false)).toEqual({});
  expect(serverFieldErrors(failure('invalid_request'), false)).toEqual({});
  expect(
    serverFieldErrors(
      {
        ...failure('invalid_request'),
        details: [{ path: '/body/slug', code: 'invalid' }],
      } as ApiResult<unknown>,
      false,
    ),
  ).toEqual({ slug: SLUG_RULE });
});
it('renders saved full access and the legacy warning without approval controls', () => {
  const html = renderToString(
    createElement(ProjectForm, {
      project: {
        name: 'Legacy',
        slug: 'legacy',
        tokenMaxScope: 'full',
        requirePublishApproval: true,
      },
      disabled: false,
      submit: async () => undefined,
    }),
  );
  expect(html).toContain(
    'Publish approval is saved as required, but approval is not enforced in this version.',
  );
  expect(html).toMatch(/name="tokenMaxScope"[^>]*checked=""[^>]*value="full"/);
  expect(html).not.toContain('name="requirePublishApproval"');
  expect(html).not.toContain('name="slug"');
  expect(html).toContain('/legacy/npm/');
  expect(html).toContain('Save settings');
});
it('renders one labeled create form with default radio, help and placeholder URLs', () => {
  const html = renderToString(
    createElement(ProjectForm, { disabled: false, submit: async () => undefined }),
  );
  expect(html).toContain('<fieldset');
  expect(html).toContain('<legend');
  expect(html).toContain('aria-describedby=');
  expect(html).toMatch(/name="tokenMaxScope"[^>]*checked=""[^>]*value="read"/);
  expect(html).toContain('/{project-slug}/npm/');
  expect(html).toContain('role="status"');
  expect(html).not.toContain('name="requirePublishApproval"');
  expect(html).not.toContain('<h2');
});
