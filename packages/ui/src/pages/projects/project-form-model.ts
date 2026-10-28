import type { ApiResult } from '../../api.js';

export type TokenScope = 'read' | 'write' | 'full';
export const PROJECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SLUG_RULE =
  '1–64 lowercase letters, numbers or hyphens. Start and end with a letter or number.';
export interface ProjectDraft {
  name: string;
  slug: string;
  manualSlug: boolean;
  tokenMaxScope: TokenScope;
}
export type FormErrors = Partial<Record<'name' | 'slug' | 'tokenMaxScope', string>>;
export function suggestedSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}
export function changeName(draft: ProjectDraft, name: string): ProjectDraft {
  return { ...draft, name, slug: draft.manualSlug ? draft.slug : suggestedSlug(name) };
}
export function changeSlug(draft: ProjectDraft, slug: string): ProjectDraft {
  return { ...draft, slug, manualSlug: true };
}
export function useSuggestedSlug(draft: ProjectDraft): ProjectDraft {
  return { ...draft, slug: suggestedSlug(draft.name), manualSlug: false };
}
export function validateDraft(draft: ProjectDraft, editing = false): FormErrors {
  const errors: FormErrors = {};
  if (!draft.name.trim()) errors.name = 'Enter a project name.';
  else if ([...draft.name].length > 100) errors.name = 'Use 100 characters or fewer.';
  else if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(draft.name))
    errors.name = 'Use a name without control or formatting characters.';
  if (!editing && !PROJECT_SLUG_PATTERN.test(draft.slug))
    errors.slug =
      !draft.slug && draft.name && !suggestedSlug(draft.name)
        ? 'Enter a project slug using lowercase letters, numbers or hyphens.'
        : SLUG_RULE;
  return errors;
}
export function projectBody(draft: ProjectDraft, editing: boolean) {
  return {
    name: draft.name,
    tokenMaxScope: draft.tokenMaxScope,
    ...(editing ? {} : { slug: draft.slug }),
  };
}
export function serverFieldErrors(result: ApiResult<unknown>, editing: boolean): FormErrors {
  if (result.ok) return {};
  if (!editing && result.code === 'duplicate')
    return { slug: 'This project slug is already in use. Choose another.' };
  const errors: FormErrors = {};
  for (const detail of result.details) {
    if (detail.location && detail.location !== 'body') continue;
    if (detail.path === '/body/name') errors.name = 'Check the entered values and try again.';
    if (!editing && detail.path === '/body/slug') errors.slug = SLUG_RULE;
    if (detail.path === '/body/tokenMaxScope')
      errors.tokenMaxScope = 'Check the entered values and try again.';
  }
  return errors;
}
export const LOWER_CAP_NOTICE =
  'This change limits existing personal and service tokens on their next request. Downloads can continue, but access above this limit will stop. Check any CI jobs that use these tokens.';
export function capNotice(saved: TokenScope, draft: TokenScope) {
  const scopes = ['read', 'write', 'full'];
  return saved === draft
    ? null
    : scopes.indexOf(draft) < scopes.indexOf(saved)
      ? LOWER_CAP_NOTICE
      : 'Existing tokens may regain access if their scope and permissions allow it.';
}
