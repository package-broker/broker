import { useId, useState, type ReactNode } from 'react';
import type { operations } from '../../api-types.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { permissionDescriptions } from './permission-descriptions.js';
import {
  roleDescription,
  scopeRoles,
  type Catalogue,
  type Provider,
  type Role,
} from './role-catalogue.js';

type GrantInput = operations['createGrant']['requestBody']['content']['application/json'];
export interface GrantDraft {
  type: 'email' | 'group';
  email: string;
  group: string;
  provider: string;
  roleId: string;
}
export function grantBody(
  draft: GrantDraft,
): { body: GrantInput; errors?: never } | { errors: Record<string, string>; body?: never } {
  const errors: Record<string, string> = {};
  const email = draft.email.trim().toLowerCase();
  if (draft.type === 'email') {
    const domain = email.slice(email.indexOf('@') + 1);
    if (
      email.length > 254 ||
      !/^[\x21-\x7e]+$/.test(email) ||
      !/^[^@]+@[^@]+$/.test(email) ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        domain,
      ) ||
      !/[a-z]/.test(domain.slice(domain.lastIndexOf('.') + 1))
    )
      errors['email'] = 'Enter a valid sign-in email address.';
  } else {
    if (!draft.provider) errors['provider'] = 'Choose a sign-in provider.';
    if (!draft.group) errors['group'] = 'Enter the group value sent by your provider.';
    else if (draft.group !== draft.group.trim())
      errors['group'] =
        "Remove spaces at the start or end. Keep the group's spelling and capitalization.";
    else if (draft.group.length > 256 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(draft.group))
      errors['group'] = 'Enter the group value sent by your provider.';
  }
  if (!draft.roleId) errors['roleId'] = 'Choose a role to review this grant.';
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      roleId: draft.roleId,
      subject:
        draft.type === 'email'
          ? { type: 'email', value: email }
          : { type: 'group', provider: draft.provider, value: draft.group },
    },
  };
}
export function grantSummary(
  draft: GrantDraft,
  role: Pick<Role, 'name' | 'key' | 'permissions'> | undefined,
  provider: Provider | undefined,
  project: string | null,
  organization: string,
) {
  if (draft.type === 'email' && !draft.email.trim())
    return 'Enter an email address to review this grant.';
  if (draft.type === 'group' && (!provider || !draft.group))
    return 'Choose a provider and enter a group value to review this grant.';
  if (!draft.roleId) return 'Choose a role to review this grant.';
  const subject =
    draft.type === 'email'
      ? draft.email.trim().toLowerCase()
      : `Members of ${draft.group} signing in with ${provider!.displayName}`;
  const context =
    project === null
      ? `for ${organization}${role?.key === 'organization_auditor' ? ', including read access across projects' : role?.permissions.some((p) => p.startsWith('project:')) ? ', including access across projects' : ''}`
      : `on project ${project}`;
  return `${subject} will get ${role?.name ?? 'the selected role'} ${context}.`;
}
function FormField({
  id,
  label,
  help,
  error,
  note,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | undefined;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? (
        <p id={`${id}-help`} className="text-sm text-neutral-600">
          {help}
        </p>
      ) : null}
      {note ? <p className="text-sm text-neutral-600">{note}</p> : null}
      {error ? (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
export function RolePicker({
  catalogue,
  project,
  value,
  onChange,
  id,
  error,
  retry,
}: {
  catalogue: Catalogue;
  project: string | null;
  value: string;
  onChange: (value: string) => void;
  id: string;
  error?: string | undefined;
  retry: () => void;
}) {
  const roles = scopeRoles(catalogue.roles, project);
  const selected = roles.find((role) => role.id === value);
  const describedBy = `${id}-help${error ? ` ${id}-error` : ''}`;
  if (catalogue.status === 'forbidden')
    return (
      <>
        <p className="lg:col-span-2">
          Role choices are unavailable for your account. Ask an organization administrator to grant
          access.
        </p>
        <FormField
          id={id}
          label="Enter a role ID"
          help="Ask an organization administrator for the role ID."
          error={error}
        >
          <Input
            id={id}
            name="roleId"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={!!error}
            aria-describedby={describedBy}
          />
        </FormField>
      </>
    );
  return (
    <>
      <div className="grid min-w-0 gap-2">
        <FormField id={id} label="Role" error={error}>
          <Select
            id={id}
            name="roleId"
            value={selected ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            disabled={catalogue.status !== 'ready' || !roles.length}
            aria-invalid={!!error}
            aria-describedby={describedBy}
          >
            <option value="">Choose a role</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        </FormField>
        <div id={`${id}-help`} className="grid gap-2 text-sm">
          {catalogue.status === 'loading' ? (
            <p>Loading roles…</p>
          ) : catalogue.status === 'error' ? (
            <>
              <p role="alert">Roles could not be loaded. Try again.</p>
              <Button type="button" variant="outline" onClick={retry}>
                Retry roles
              </Button>
            </>
          ) : !roles.length ? (
            <p>No roles are available to grant at this scope.</p>
          ) : null}
          {selected ? (
            <>
              <p>{roleDescription(selected)}</p>
              <p>{selected.isSystem ? 'System role' : 'Custom role'}</p>
              {selected.isSystem && selected.key === 'project_developer' ? (
                <p>Suggested for developers; includes package read and publish permissions.</p>
              ) : null}
              {selected.permissions.includes('project:packages:write') ? (
                <p>
                  Publishing is not available in this version. This role includes the publish
                  permission.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {selected ? (
        <details key={selected.id} className="min-w-0 lg:col-span-2">
          <summary className="cursor-pointer underline">
            View permissions ({selected.permissions.length})
          </summary>
          <ul>
            {selected.permissions.map((permission) => (
              <li key={permission} className="my-2">
                <span>{permissionDescriptions[permission]}</span>{' '}
                <code className="break-all">{permission}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
export interface GrantFormProps {
  catalogue: Catalogue;
  providers: Provider[];
  providerStatus: 'ready' | 'loading' | 'error';
  project: string | null;
  organization: string;
  busy: boolean;
  retry: () => void;
  submit: (body: GrantInput) => Promise<void>;
}
export function GrantForm(props: GrantFormProps) {
  const prefix = useId();
  const [draft, setDraft] = useState<GrantDraft>({
    type: 'email',
    email: '',
    group: '',
    provider: '',
    roleId: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [chosenRole, setChosenRole] = useState(false);
  const roles = scopeRoles(props.catalogue.roles, props.project);
  const suggested =
    props.project === null
      ? ''
      : (roles.find((role) => role.isSystem && role.key === 'project_developer')?.id ?? '');
  const roleId = chosenRole ? draft.roleId : suggested;
  const provider = props.providers.length === 1 ? props.providers[0]!.id : draft.provider;
  const current = { ...draft, roleId, provider };
  const selectedRole = roles.find((role) => role.id === roleId);
  const selectedProvider = props.providers.find((item) => item.id === provider);
  const field = (name: string) => ({
    id: `${prefix}-${name}`,
    'aria-invalid': !!errors[name],
    'aria-describedby': `${prefix}-${name}-help${errors[name] ? ` ${prefix}-${name}-error` : ''}`,
  });
  const update = (patch: Partial<GrantDraft>) => {
    setDraft({ ...draft, ...patch });
    setErrors({});
  };
  const rolesReady =
    props.catalogue.status === 'forbidden' ||
    (props.catalogue.status === 'ready' && roles.length > 0);
  return (
    <form
      noValidate
      className="my-6 grid max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.busy || !rolesReady) return;
        const result = grantBody(current);
        const invalid = result.errors ?? {};
        if (
          draft.type === 'email' &&
          event.currentTarget.querySelector<HTMLInputElement>('[name="email"]')?.validity
            .typeMismatch
        )
          invalid['email'] = 'Enter a valid sign-in email address.';
        if (draft.type === 'group' && !selectedProvider)
          invalid['provider'] = provider
            ? 'This provider is no longer available. Choose another provider.'
            : 'Choose a sign-in provider.';
        if (props.catalogue.status === 'ready' && !selectedRole)
          invalid['roleId'] = 'Choose a role to review this grant.';
        setErrors(invalid);
        const first = ['email', 'provider', 'group', 'roleId'].find((name) => invalid[name]);
        if (first) {
          event.currentTarget.querySelector<HTMLElement>(`[id="${prefix}-${first}"]`)?.focus();
          return;
        }
        if (result.body) void props.submit(result.body);
      }}
    >
      <p className="lg:col-span-2">Give a person or a sign-in group a role.</p>
      <div className="lg:col-span-2">
        <p className="font-semibold">
          Access to:{' '}
          {props.project === null
            ? `Organization · ${props.organization}`
            : `Project · ${props.project}`}
        </p>
        <p className="text-sm text-neutral-600">
          {props.project === null
            ? 'Organization roles can give access across projects. To give a development group access, choose a project.'
            : 'This grant applies to this project.'}
        </p>
        {props.project === null ? (
          <a className="underline" href="#/projects">
            Choose a project
          </a>
        ) : null}
      </div>
      <fieldset className="grid min-w-0 gap-2 lg:col-span-2">
        <legend className="font-semibold">Who gets access</legend>
        {(['email', 'group'] as const).map((type) => (
          <div key={type} className="flex items-center gap-2">
            <input
              id={`${prefix}-${type}-radio`}
              type="radio"
              name="type"
              value={type}
              checked={draft.type === type}
              disabled={
                type === 'group' && (props.providerStatus !== 'ready' || !props.providers.length)
              }
              aria-describedby={type === 'group' ? `${prefix}-provider-status` : undefined}
              onChange={() => update({ type })}
            />
            <Label htmlFor={`${prefix}-${type}-radio`}>
              {type === 'email' ? 'Person (email)' : 'Group (from your sign-in provider)'}
            </Label>
          </div>
        ))}
      </fieldset>
      <div id={`${prefix}-provider-status`} className="lg:col-span-2">
        {props.providerStatus === 'error' ? (
          <>
            <p role="alert">Sign-in providers could not be loaded. Try again.</p>
            <Button type="button" variant="outline" onClick={props.retry}>
              Retry sign-in providers
            </Button>
          </>
        ) : props.providerStatus === 'loading' ? (
          <p>Loading sign-in providers…</p>
        ) : !props.providers.length ? (
          <p>
            Group access needs a sign-in provider that sends groups. Grant access to individual
            people instead.
          </p>
        ) : null}
      </div>
      {draft.type === 'email' ? (
        <FormField
          id={`${prefix}-email`}
          label="Email address"
          help="Use the person's sign-in email. Email matching ignores capitalization. Their provider must verify the email and allow its domain."
          note="This creates an access rule. No invitation email is sent."
          error={errors['email']}
        >
          <Input
            {...field('email')}
            type="email"
            name="email"
            autoComplete="email"
            placeholder="alex@fastwhitecat.com"
            value={draft.email}
            onChange={(event) => update({ email: event.target.value })}
          />
        </FormField>
      ) : (
        <>
          <div className="grid min-w-0 items-start gap-x-6 gap-y-4 lg:col-span-2 lg:grid-cols-2">
            {props.providers.length === 1 ? (
              <p>Members signing in with {selectedProvider?.displayName}</p>
            ) : (
              <FormField
                id={`${prefix}-provider`}
                label="Sign-in provider"
                help="Choose the provider members use to sign in to Package Broker."
                error={errors['provider']}
              >
                <Select
                  {...field('provider')}
                  name="provider"
                  value={provider}
                  onChange={(event) => update({ provider: event.target.value })}
                >
                  <option value="">Choose a provider</option>
                  {props.providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
          </div>
          <FormField
            id={`${prefix}-group`}
            label="Group value"
            help="Use the exact group value sent by this provider. A group email works only if the provider sends that email as a group value."
            note="Package Broker cannot check whether this group exists. Ask a member to sign in and confirm their access after saving."
            error={errors['group']}
          >
            <Input
              {...field('group')}
              name="group"
              value={draft.group}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ group: event.target.value })}
            />
          </FormField>
        </>
      )}
      <RolePicker
        catalogue={props.catalogue}
        project={props.project}
        id={`${prefix}-roleId`}
        value={roleId}
        onChange={(value) => {
          setChosenRole(true);
          update({ roleId: value });
        }}
        error={errors['roleId']}
        retry={props.retry}
      />
      <div aria-live="polite" className="min-w-0 break-words rounded border p-3 lg:col-span-2">
        <p>
          {grantSummary(current, selectedRole, selectedProvider, props.project, props.organization)}
        </p>
        {draft.type === 'group' ? (
          <p className="text-sm">Applies when the provider reports this exact group value.</p>
        ) : null}
      </div>
      <div className="flex flex-col items-start sm:flex-row lg:col-span-2">
        <Button
          className="w-full sm:w-auto lg:w-auto"
          type="submit"
          disabled={
            props.busy ||
            !rolesReady ||
            (draft.type === 'group' &&
              (props.providerStatus !== 'ready' || !props.providers.length))
          }
        >
          Create grant
        </Button>
      </div>
    </form>
  );
}
export function ChangeRoleForm({
  catalogue,
  project,
  currentRole,
  busy,
  retry,
  submit,
}: {
  catalogue: Catalogue;
  project: string | null;
  currentRole: string;
  busy: boolean;
  retry: () => void;
  submit: (roleId: string) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState(currentRole);
  const roles = scopeRoles(catalogue.roles, project);
  const valid =
    !!value &&
    (catalogue.status === 'forbidden' ||
      (catalogue.status === 'ready' && roles.some((role) => role.id === value)));
  return (
    <form
      className="grid max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && valid) void submit(value);
      }}
    >
      <p className="lg:col-span-2">
        To change who this grant applies to, create a new grant and revoke this one.
      </p>
      <RolePicker
        id={id}
        catalogue={catalogue}
        project={project}
        value={value}
        onChange={setValue}
        retry={retry}
      />
      <p aria-live="polite" className="min-w-0 break-words lg:col-span-2">
        {roles.find((role) => role.id === value)?.name
          ? `Save ${roles.find((role) => role.id === value)!.name} ${project === null ? 'for the organization' : `on project ${project}`}.`
          : 'Choose a role to review this grant.'}
      </p>
      <div className="flex flex-col items-start sm:flex-row lg:col-span-2">
        <Button className="w-full sm:w-auto lg:w-auto" type="submit" disabled={busy || !valid}>
          Save role
        </Button>
      </div>
    </form>
  );
}
