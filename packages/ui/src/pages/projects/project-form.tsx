import { useId, useRef, useState } from 'react';
import type { ApiResult } from '../../api.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { failureNotice } from '../management.js';
import {
  capNotice,
  changeName,
  changeSlug,
  projectBody,
  PROJECT_SLUG_PATTERN,
  serverFieldErrors,
  SLUG_RULE,
  useSuggestedSlug,
  validateDraft,
  type FormErrors,
  type TokenScope,
} from './project-form-model.js';

const policies = [
  {
    value: 'read',
    label: 'Install and download',
    summary: 'Install and download only',
    description: 'Read project details and download packages.',
  },
  {
    value: 'write',
    label: 'Include publish permission',
    summary: 'Publish permission included',
    description:
      'Also allow the package publishing permission. Publishing is not available in this version.',
  },
  {
    value: 'full',
    label: 'Include grants, sources and audit access',
    summary: 'Grants, sources and audit access included',
    description:
      'Also allow reading project grants, sources and audit records, plus the publish permission.',
  },
] as const;
export interface SavedProject {
  name: string;
  slug: string;
  tokenMaxScope: TokenScope;
  requirePublishApproval: boolean;
}
export function ProjectForm(props: {
  project?: SavedProject;
  disabled: boolean;
  submit: (body: ReturnType<typeof projectBody>) => Promise<ApiResult<unknown> | undefined>;
}) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const policy = useRef<HTMLDetailsElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const editing = !!props.project;
  const [draft, setDraft] = useState({
    name: props.project?.name ?? '',
    slug: props.project?.slug ?? '',
    tokenMaxScope: props.project?.tokenMaxScope ?? 'read',
    manualSlug: false,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const focusError = (next: FormErrors) => {
    setErrors(next);
    const field = (['name', 'slug', 'tokenMaxScope'] as const).find((key) => next[key]);
    if (field === 'tokenMaxScope' && policy.current) policy.current.open = true;
    if (field) form.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();
  };
  const previewSlug = PROJECT_SLUG_PATTERN.test(draft.slug) ? draft.slug : '{project-slug}';
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const changeNotice = props.project
    ? capNotice(props.project.tokenMaxScope, draft.tokenMaxScope)
    : null;
  return (
    <form
      ref={form}
      noValidate
      aria-label={editing ? 'Project settings' : 'New project'}
      className="my-6 grid min-w-0 max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (props.disabled || busy) return;
        setNotice('');
        const next = validateDraft(draft, editing);
        focusError(next);
        if (Object.keys(next).length) return;
        setBusy(true);
        try {
          const result = await props.submit(projectBody(draft, editing));
          if (result && !result.ok) {
            const fieldErrors = serverFieldErrors(result, editing);
            focusError(fieldErrors);
            if (!Object.keys(fieldErrors).length) status.current?.focus();
            setNotice(
              result.status === 412
                ? 'This project changed while you were editing. Reload the latest settings before saving.'
                : failureNotice(result),
            );
          } else if (result?.ok)
            setNotice(
              editing
                ? 'Access policy saved. Existing tokens now use this limit.'
                : 'Project created.',
            );
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid min-w-0 gap-1">
        <Label htmlFor={`${id}-name`}>Project name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          required
          className="h-11"
          placeholder="e.g. FastWhiteCat"
          value={draft.name}
          onChange={(event) => setDraft(changeName(draft, event.target.value))}
          aria-describedby={`${id}-name-help ${id}-name-error`}
          aria-invalid={!!errors.name}
        />
        <p id={`${id}-name-help`} className="text-sm text-neutral-600">
          A name your team will recognize. You can change it later.
        </p>
        <p id={`${id}-name-error`} className="text-sm text-red-700">
          {errors.name}
        </p>
      </div>
      <div className="grid min-w-0 gap-1">
        {editing ? (
          <>
            <p className="text-sm font-medium">Project slug</p>
            <p className="break-all">{draft.slug}</p>
          </>
        ) : (
          <>
            <Label htmlFor={`${id}-slug`}>Project slug</Label>
            <Input
              id={`${id}-slug`}
              name="slug"
              required
              className="h-11"
              placeholder="e.g. fastwhitecat"
              value={draft.slug}
              onChange={(event) => setDraft(changeSlug(draft, event.target.value))}
              aria-describedby={`${id}-slug-help ${id}-slug-rule ${id}-slug-error`}
              aria-invalid={!!errors.slug}
            />
            {draft.manualSlug ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 justify-self-start"
                onClick={() => setDraft(useSuggestedSlug(draft))}
              >
                Use suggested slug
              </Button>
            ) : null}
          </>
        )}
        <p id={`${id}-slug-help`} className="text-sm text-neutral-600">
          Used in repository URLs and CLI commands. You cannot change it later.
        </p>
        {!editing ? (
          <>
            <p id={`${id}-slug-rule`} className="text-sm text-neutral-600">
              {SLUG_RULE}
            </p>
            <p id={`${id}-slug-error`} className="text-sm text-red-700">
              {errors.slug}
            </p>
          </>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-2 rounded-md border border-neutral-300 bg-neutral-50 p-4 lg:col-span-2">
        <p className="text-sm font-medium">Repository URLs</p>
        <dl className="grid min-w-0 gap-2 text-sm">
          <div className="min-w-0">
            <dt>Composer</dt>
            <dd className="overflow-x-auto whitespace-nowrap" tabIndex={0}>
              <code>{`${origin}/${previewSlug}`}</code>
            </dd>
          </div>
          <div className="min-w-0">
            <dt>npm</dt>
            <dd className="overflow-x-auto whitespace-nowrap" tabIndex={0}>
              <code>{`${origin}/${previewSlug}/npm/`}</code>
            </dd>
          </div>
        </dl>
      </div>
      <details ref={policy} className="min-w-0 rounded-md border border-neutral-300 lg:col-span-2">
        <summary className="min-h-11 cursor-pointer p-4 font-medium focus-visible:ring-2 focus-visible:ring-blue-600">
          Access policy
          <span className="block text-sm font-normal text-neutral-600">
            {policies.find((entry) => entry.value === draft.tokenMaxScope)?.summary}
          </span>
        </summary>
        <fieldset
          className="m-4 grid min-w-0 gap-3"
          aria-describedby={`${id}-policy-help ${id}-policy-note ${id}-policy-error`}
        >
          <legend className="font-medium">What can tokens do on this project?</legend>
          <p id={`${id}-policy-help`} className="text-sm text-neutral-600">
            Sets the maximum access for personal and service tokens, including tokens used by CI.
            Each token still needs its own permissions. Your access in the admin UI is unchanged.
          </p>
          {policies.map((entry) => (
            <Label
              key={entry.value}
              htmlFor={`${id}-${entry.value}`}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-neutral-300 p-3 has-checked:border-blue-700 has-checked:bg-blue-50"
            >
              <input
                id={`${id}-${entry.value}`}
                type="radio"
                name="tokenMaxScope"
                value={entry.value}
                checked={draft.tokenMaxScope === entry.value}
                onChange={() => setDraft({ ...draft, tokenMaxScope: entry.value })}
                className="mt-1 accent-blue-700 focus-visible:ring-2 focus-visible:ring-blue-600"
                aria-describedby={`${id}-${entry.value}-description ${id}-policy-error`}
                aria-invalid={!!errors.tokenMaxScope}
              />
              <span>
                {entry.label}
                {entry.value === 'read' ? (
                  <span className="ml-2 inline-block rounded bg-blue-100 px-1 text-xs text-blue-800">
                    Recommended
                  </span>
                ) : null}
                <span
                  id={`${id}-${entry.value}-description`}
                  className="mt-1 block text-sm font-normal text-neutral-600"
                >
                  {entry.description}
                </span>
              </span>
            </Label>
          ))}
          <p id={`${id}-policy-note`} className="text-sm text-neutral-600">
            Tokens cannot change project settings or delete packages. Publishing is not available in
            this version.
          </p>
          <p id={`${id}-policy-error`} className="text-sm text-red-700">
            {errors.tokenMaxScope}
          </p>
        </fieldset>
      </details>
      {props.project?.requirePublishApproval ? (
        <p className="text-sm text-neutral-600 lg:col-span-2">
          Publish approval is saved as required, but approval is not enforced in this version.
        </p>
      ) : null}
      {changeNotice ? (
        <p className="text-sm text-neutral-600 lg:col-span-2">{changeNotice}</p>
      ) : null}
      <div className="lg:col-span-2">
        <Button
          type="submit"
          className="min-h-11 w-full sm:w-auto lg:w-auto"
          disabled={props.disabled || busy}
        >
          {busy ? (
            editing ? (
              'Saving settings…'
            ) : (
              'Creating project…'
            )
          ) : editing ? (
            'Save settings'
          ) : (
            <>Create project</>
          )}
        </Button>
      </div>
      <p ref={status} role="status" tabIndex={-1} className="lg:col-span-2">
        {busy
          ? editing
            ? 'Saving settings…'
            : 'Creating project…'
          : notice || (Object.keys(errors).length ? 'Check the entered values and try again.' : '')}
      </p>
    </form>
  );
}
