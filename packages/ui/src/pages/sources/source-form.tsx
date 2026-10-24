import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { operations } from '../../api-types.js';
import type { ApiErrorDetail } from '../../api.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import type { Source } from '../sources.js';

export type CreateSource =
  operations['createOrganizationSource']['requestBody']['content']['application/json'];
export type SourceChanges =
  operations['updateOrganizationSource']['requestBody']['content']['application/json'];
export const SOURCE_TYPES = {
  composer: ['packagist_proxy', 'composer_repository', 'vcs'],
  npm: ['npmjs_proxy', 'npm_registry'],
} as const;
const DEFAULT_URL = {
  packagist_proxy: 'https://repo.packagist.org',
  npmjs_proxy: 'https://registry.npmjs.org',
};
export const SOURCE_TYPE_LABELS: Record<CreateSource['type'], string> = {
  packagist_proxy: 'Packagist proxy',
  composer_repository: 'Composer repository',
  vcs: 'Git repository',
  npmjs_proxy: 'npmjs proxy',
  npm_registry: 'Private npm registry',
  hosted: 'Hosted repository',
};
const TYPE_DESCRIPTIONS: Partial<Record<CreateSource['type'], string>> = {
  packagist_proxy: 'Fetch public Composer packages on demand.',
  composer_repository:
    'Import selected packages from Satis, Private Packagist, or another Composer repository.',
  vcs: 'Import a Composer package from GitHub or another Git repository.',
  npmjs_proxy: 'Fetch public npm packages on demand.',
  npm_registry: 'Fetch packages in selected scopes from another npm registry.',
};
const FIELD_LABELS: Record<string, string> = {
  name: 'Source name',
  ecosystem: 'Ecosystem',
  type: 'Source type',
  url: 'Repository URL',
  userAgent: 'User-Agent override',
  pollIntervalSeconds: 'Sync interval (seconds)',
  removalPolicy: 'When a package disappears upstream',
  defaultVisibleToNewProjects: 'Visible to new projects',
  retentionDaysOverride: 'Archive retention (days)',
  'config/provider': 'Repository provider',
  'config/repository': 'GitHub repository',
  'config/installationId': 'GitHub App installation ID',
  githubAuthentication: 'GitHub authentication',
  'config/packageName': 'Composer package name override',
  'config/refs/branches': 'Branches to import',
  'config/refs/tags': 'Import tags',
  'config/selection/packages': 'Package names (one per line)',
  'config/selection/patterns': 'Package patterns (one per line)',
  'config/selection/expandPatterns': 'Expand patterns',
  'config/distHosts': 'Additional archive hosts',
  'config/mirrorsFallback': 'Try repository mirrors if an archive download fails',
  'config/scopes': 'Package scopes (one per line)',
  'config/githubToken': 'Use GitHub token',
};
const FIELD_MESSAGES: Record<string, string> = {
  name: 'Enter a source name.',
  ecosystem: 'Choose an ecosystem.',
  type: 'Choose a source type.',
  url: 'Enter a valid HTTP or HTTPS URL without credentials, a query, or a fragment.',
  userAgent: 'Enter a valid User-Agent header without line breaks.',
  pollIntervalSeconds: 'Enter a whole number of seconds greater than 0.',
  removalPolicy: 'Choose what happens when a package disappears upstream.',
  defaultVisibleToNewProjects: 'Choose whether this source is visible to new projects.',
  retentionDaysOverride:
    'Enter a whole number of days that does not shorten organization retention.',
  'config/provider':
    'Choose a supported repository provider. Git over HTTP(S) and SSH require the Node runtime.',
  'config/repository':
    'Enter a valid repository for the selected provider: owner/repository for GitHub, or a clone URL for Git.',
  'config/installationId': 'Enter a positive whole-number installation ID.',
  githubAuthentication: 'Choose GitHub App or Personal access token.',
  'config/packageName': 'Enter a Composer package name, such as acme/payments.',
  'config/refs/branches': 'Enter valid branch names, one per line, without duplicates.',
  'config/refs/tags': 'Choose whether to import tags.',
  'config/selection/packages':
    'Enter valid Composer package names, one per line, without duplicates.',
  'config/selection/patterns': 'Enter valid package patterns, such as acme/*, without duplicates.',
  'config/selection/expandPatterns': 'Choose whether to expand patterns.',
  'config/distHosts': 'Enter hostnames only, one per line, without schemes, paths, or duplicates.',
  'config/mirrorsFallback': 'Choose whether to try repository mirrors.',
  'config/scopes': 'Enter at least one scope, such as @acme, one per line without duplicates.',
  'config/githubToken': 'Save a bearer credential before enabling the GitHub token option.',
};
const HELP: Record<string, string> = {
  pollIntervalSeconds: 'How often to check for upstream changes. 300 seconds = 5 minutes.',
  retentionDaysOverride:
    'Leave blank to use the organization setting. An override can only lengthen retention.',
  'config/distHosts':
    'One hostname per line. Archive downloads may come from these hosts; the source credential is also sent to them.',
  'config/selection/packages':
    'Packages matching either list are selected. Empty lists select no packages.',
  'config/scopes': 'One scope per line, including @. Only these scopes use this registry.',
  'config/packageName': 'Leave blank to use the name in composer.json.',
  'config/refs/branches': 'One branch name per line. Leave blank to import no branches.',
  'config/installationId':
    'Enter the numeric installation ID for the account that owns this repository.',
};
const PLACEHOLDERS: Record<string, string> = {
  userAgent: 'Use broker default',
  retentionDaysOverride: 'Use organization default',
  'config/selection/packages': 'acme/payments',
  'config/selection/patterns': 'acme/*',
  'config/scopes': '@acme',
  'config/distHosts': 'downloads.example.com',
  'config/packageName': 'acme/payments',
  'config/refs/branches': 'main',
  'config/installationId': '12345678',
};

export function sourceFieldErrors(details: ApiErrorDetail[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const detail of details) {
    const path = detail.path.replace(/^\/body\//, '').replace(/^\//, '');
    const field = Object.keys(FIELD_LABELS).find(
      (key) => path === key || path.startsWith(`${key}/`),
    );
    if (field) errors[field] = FIELD_MESSAGES[field] ?? 'Review this setting.';
  }
  return errors;
}

export function validateSourceForm(
  data: FormData,
  type: CreateSource['type'],
  editing: boolean,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const value = (name: string) => String(data.get(name) ?? '').trim();
  const whole = (name: string, minimum: number) => {
    const number = Number(value(name));
    if (!value(name) || !Number.isSafeInteger(number) || number < minimum)
      errors[name] = FIELD_MESSAGES[name] ?? 'Review this setting.';
  };
  if (!editing && !value('name')) errors.name = FIELD_MESSAGES['name']!;
  if (
    (!editing || data.has('replaceNetwork')) &&
    (type === 'composer_repository' || type === 'npm_registry') &&
    !value('url')
  )
    errors.url = FIELD_MESSAGES['url']!;
  whole('pollIntervalSeconds', 1);
  if ((!editing || data.has('replaceDefaults')) && value('retentionDaysOverride'))
    whole('retentionDaysOverride', 0);
  if (!editing || data.has('replaceConfig')) {
    if (
      type === 'composer_repository' &&
      !value('config/selection/packages') &&
      !value('config/selection/patterns')
    )
      errors['config/selection/packages'] = 'Add at least one package name or pattern';
    if (type === 'npm_registry' && !value('config/scopes'))
      errors['config/scopes'] = FIELD_MESSAGES['config/scopes']!;
    if (type === 'vcs' && !value('config/repository'))
      errors['config/repository'] = FIELD_MESSAGES['config/repository']!;
    if (
      type === 'vcs' &&
      value('config/provider') === 'github' &&
      value('githubAuthentication') !== 'token'
    )
      whole('config/installationId', 1);
  }
  return errors;
}

function integer(value: string, minimum: number) {
  const number = Number(value);
  if (!value.trim() || !Number.isSafeInteger(number) || number < minimum)
    throw new Error('Enter valid whole numbers for the numeric fields.');
  return number;
}

export function sourceSubmission(
  data: FormData,
  ecosystem: CreateSource['ecosystem'],
  type: CreateSource['type'],
  editing: boolean,
): CreateSource | SourceChanges {
  const value = (name: string) => String(data.get(name) ?? '');
  const checked = (name: string) => data.has(name);
  const list = (name: string) =>
    value(name)
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  const changes: SourceChanges = {
    pollIntervalSeconds: integer(value('pollIntervalSeconds'), 1),
    removalPolicy: value('removalPolicy') as Source['removalPolicy'],
  };
  if (!editing || checked('replaceDefaults')) {
    changes.defaultVisibleToNewProjects = checked('defaultVisibleToNewProjects');
    changes.retentionDaysOverride =
      value('retentionDaysOverride').trim() === ''
        ? null
        : integer(value('retentionDaysOverride'), 0);
  }
  if (!editing || checked('replaceNetwork')) {
    changes.userAgent = value('userAgent') || null;
    if (type !== 'vcs') changes.url = value('url') || null;
  }
  if (!editing || checked('replaceConfig')) {
    switch (type) {
      case 'vcs':
        changes.config = {
          provider: value('config/provider') as 'github' | 'git' | 'ssh',
          repository: value('config/repository'),
          ...(value('config/provider') === 'github' && value('githubAuthentication') !== 'token'
            ? { installationId: integer(value('config/installationId'), 1) }
            : {}),
          ...(value('config/packageName') ? { packageName: value('config/packageName') } : {}),
          refs: { branches: list('config/refs/branches'), tags: checked('config/refs/tags') },
        };
        break;
      case 'composer_repository':
        changes.config = {
          selection: {
            packages: list('config/selection/packages'),
            patterns: list('config/selection/patterns'),
            expandPatterns: checked('config/selection/expandPatterns'),
          },
          distHosts: list('config/distHosts'),
          mirrorsFallback: checked('config/mirrorsFallback'),
        };
        break;
      case 'npm_registry':
        changes.config = { scopes: list('config/scopes'), distHosts: list('config/distHosts') };
        break;
      case 'packagist_proxy':
        changes.config = { githubToken: editing && checked('config/githubToken') };
        break;
      case 'npmjs_proxy':
        changes.config = {};
        break;
    }
  }
  return editing ? changes : { name: value('name'), ecosystem, type, ...changes };
}

export function focusSourceError(form: HTMLFormElement | null, errors: Record<string, string>) {
  if (!form) return;
  const control = Array.from(form.elements).find(
    (element) => (element.getAttribute('name') ?? '') in errors,
  ) as HTMLElement | undefined;
  if (!control) return;
  const details = control.closest('details');
  if (details) details.open = true;
  control.focus();
}

export function SourceForm({
  source,
  busy,
  errors: serverErrors,
  alert,
  onSubmit,
  onClose,
}: {
  source: Source | null;
  busy: boolean;
  errors: Record<string, string>;
  alert: string | null;
  onSubmit: (body: CreateSource | SourceChanges) => void;
  onClose: () => void;
}) {
  const [ecosystem, setEcosystem] = useState<CreateSource['ecosystem']>(
    source?.ecosystem ?? 'composer',
  );
  const [type, setType] = useState<CreateSource['type']>(source?.type ?? 'packagist_proxy');
  const [provider, setProvider] = useState<'github' | 'git' | 'ssh'>('github');
  const [githubAuthentication, setGithubAuthentication] = useState(
    source?.githubAuthentication ?? 'app',
  );
  const [replaceConfig, setReplaceConfig] = useState(false);
  const [replaceNetwork, setReplaceNetwork] = useState(false);
  const [replaceDefaults, setReplaceDefaults] = useState(false);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const errors = { ...serverErrors, ...localErrors };
  const editing = source !== null;
  const proxy = type === 'packagist_proxy' || type === 'npmjs_proxy';
  const configEnabled = !editing || replaceConfig;
  const networkEnabled = !editing || replaceNetwork;

  useEffect(() => {
    focusSourceError(formRef.current, serverErrors);
  }, [serverErrors]);

  function describedBy(name: string) {
    return (
      [HELP[name] && `source-${name}-help`, errors[name] && `source-${name}-error`]
        .filter(Boolean)
        .join(' ') || undefined
    );
  }
  function feedback(name: string) {
    return (
      <>
        {HELP[name] ? (
          <p id={`source-${name}-help`} className="text-sm text-neutral-600">
            {HELP[name]}
          </p>
        ) : null}
        {errors[name] ? (
          <p id={`source-${name}-error`} className="text-sm text-red-700">
            {errors[name]}
          </p>
        ) : null}
      </>
    );
  }
  function field(name: string, control: ReactNode, label = FIELD_LABELS[name]) {
    return (
      <div className="grid gap-1" key={name}>
        <Label htmlFor={`source-${name}`}>{label}</Label>
        {control}
        {feedback(name)}
      </div>
    );
  }
  function input(
    name: string,
    options: {
      required?: boolean;
      number?: boolean;
      minimum?: number;
      value?: string | number;
      multiline?: boolean;
      label?: string;
      placeholder?: string;
    } = {},
  ) {
    const props = {
      id: `source-${name}`,
      name,
      required: options.required,
      defaultValue: options.value,
      placeholder: options.placeholder ?? PLACEHOLDERS[name],
      'aria-invalid': !!errors[name],
      'aria-describedby': describedBy(name),
    };
    return field(
      name,
      options.multiline ? (
        <textarea
          {...props}
          rows={3}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base sm:text-sm"
        />
      ) : (
        <Input
          {...props}
          className="h-11 text-base sm:text-sm"
          type={options.number ? 'number' : 'text'}
          inputMode={options.number ? 'numeric' : undefined}
          min={options.minimum}
          max={options.number ? Number.MAX_SAFE_INTEGER : undefined}
          step={options.number ? 1 : undefined}
          maxLength={name === 'url' ? 2048 : undefined}
        />
      ),
      `${options.label ?? FIELD_LABELS[name]}${options.required ? ' (required)' : ''}`,
    );
  }
  function check(
    name: string,
    label = FIELD_LABELS[name],
    onChange?: (checked: boolean) => void,
    defaultChecked?: boolean,
  ) {
    return (
      <div className="grid gap-1" key={name}>
        <Label className="flex min-h-11 items-center gap-2" htmlFor={`source-${name}`}>
          <input
            type="checkbox"
            id={`source-${name}`}
            name={name}
            defaultChecked={defaultChecked}
            onChange={onChange ? (event) => onChange(event.currentTarget.checked) : undefined}
            aria-invalid={!!errors[name]}
            aria-describedby={describedBy(name)}
          />
          {label}
        </Label>
        {feedback(name)}
      </div>
    );
  }
  function radios(
    name: string,
    value: string,
    choices: readonly (readonly [string, string, (string | undefined)?])[],
    onChange: (value: string) => void,
    horizontal = false,
  ) {
    return (
      <fieldset
        className="grid gap-1"
        aria-describedby={describedBy(name)}
        aria-invalid={!!errors[name]}
      >
        <legend className="text-sm font-medium">{FIELD_LABELS[name]}</legend>
        <div className={horizontal ? 'flex gap-4' : 'grid gap-1'}>
          {choices.map(([key, label, description]) => (
            <label key={key} className="flex min-h-11 cursor-pointer items-center gap-2 py-1">
              <input
                type="radio"
                name={name}
                value={key}
                checked={value === key}
                onChange={() => onChange(key)}
                aria-invalid={!!errors[name]}
                aria-describedby={describedBy(name)}
              />
              <span>
                <span className="text-sm font-medium">{label}</span>
                {description ? (
                  <span className="block text-sm text-neutral-600">{description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        {feedback(name)}
      </fieldset>
    );
  }
  const namePlaceholder = {
    packagist_proxy: 'Packagist',
    npmjs_proxy: 'npmjs',
    composer_repository: 'Acme Composer',
    npm_registry: 'Acme npm',
    vcs: 'Acme payments',
    hosted: '',
  }[type];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        variant="source"
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 p-6 pr-16">
          <DialogTitle>{editing ? 'Edit source' : 'Add source'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `${source.name} · ${ecosystem === 'composer' ? 'Composer' : 'npm'} · ${SOURCE_TYPE_LABELS[type]}. Name, ecosystem and source type cannot be changed.`
              : 'Add an upstream source for this organization or project.'}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          ref={formRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const next = validateSourceForm(data, type, editing);
            setLocalErrors(next);
            if (Object.keys(next).length) {
              focusSourceError(formRef.current, next);
              return;
            }
            onSubmit(sourceSubmission(data, ecosystem, type, editing));
          }}
          onInvalidCapture={(event) => {
            const control = event.target as HTMLInputElement;
            const details = control.closest('details');
            if (details) details.open = true;
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {alert || Object.keys(errors).length ? (
              <p role="alert" className="mb-4 text-sm text-red-700">
                {Object.keys(errors).length ? 'Review the highlighted fields.' : alert}
              </p>
            ) : null}
            <fieldset disabled={busy} className="grid min-w-0 gap-4">
              {!editing ? (
                <>
                  {radios(
                    'ecosystem',
                    ecosystem,
                    [
                      ['composer', 'Composer'],
                      ['npm', 'npm'],
                    ],
                    (value) => {
                      const next = value as CreateSource['ecosystem'];
                      setEcosystem(next);
                      setType(SOURCE_TYPES[next][0]);
                      setLocalErrors({});
                    },
                    true,
                  )}
                  {radios(
                    'type',
                    type,
                    SOURCE_TYPES[ecosystem].map(
                      (value) =>
                        [value, SOURCE_TYPE_LABELS[value], TYPE_DESCRIPTIONS[value]] as const,
                    ),
                    (value) => {
                      setType(value as CreateSource['type']);
                      setProvider('github');
                      setGithubAuthentication('app');
                      setLocalErrors({});
                    },
                  )}
                  {input('name', { required: true, placeholder: namePlaceholder })}
                </>
              ) : (
                <p className="text-sm text-neutral-600">
                  Some saved settings cannot be displayed. Leave a replacement option unchecked to
                  keep those settings.
                </p>
              )}
              {editing && !proxy && type !== 'vcs'
                ? check('replaceNetwork', 'Replace URL and User-Agent', setReplaceNetwork)
                : null}
              {proxy ? (
                <p className="break-words text-sm">
                  Upstream URL: {DEFAULT_URL[type as keyof typeof DEFAULT_URL]}
                </p>
              ) : null}
              {proxy && networkEnabled ? (
                <input
                  type="hidden"
                  name="url"
                  value={DEFAULT_URL[type as keyof typeof DEFAULT_URL]}
                />
              ) : null}
              {networkEnabled && !proxy && type !== 'vcs' ? (
                <div key={`network:${type}`}>
                  {input('url', {
                    required: true,
                    value: source?.url ?? '',
                    label: type === 'npm_registry' ? 'Registry URL' : 'Repository URL',
                    placeholder:
                      type === 'npm_registry'
                        ? 'https://npm.example.com'
                        : 'https://composer.example.com',
                  })}
                </div>
              ) : null}
              {editing && !proxy
                ? check('replaceConfig', 'Replace type-specific configuration', setReplaceConfig)
                : null}
              {configEnabled ? (
                <div className="grid gap-4" key={`primary:${type}`}>
                  {type === 'vcs' ? (
                    <>
                      {field(
                        'config/provider',
                        <Select
                          id="source-config/provider"
                          name="config/provider"
                          value={provider}
                          className="h-11 text-base sm:text-sm"
                          aria-invalid={!!errors['config/provider']}
                          aria-describedby={describedBy('config/provider')}
                          onChange={(event) =>
                            setProvider(event.currentTarget.value as typeof provider)
                          }
                        >
                          <option value="github">GitHub</option>
                          <option value="git">Git over HTTP(S)</option>
                          <option value="ssh">Git over SSH</option>
                        </Select>,
                      )}
                      <p className="text-sm text-neutral-600">
                        Git over HTTP(S) and SSH require the Node runtime.
                      </p>
                      <div key={provider}>
                        {input('config/repository', {
                          required: true,
                          label:
                            provider === 'github'
                              ? 'GitHub repository'
                              : provider === 'git'
                                ? 'Git repository URL'
                                : 'SSH repository',
                          placeholder:
                            provider === 'github'
                              ? 'acme/payments'
                              : provider === 'git'
                                ? 'https://git.example.com/acme/payments.git'
                                : 'git@git.example.com:acme/payments.git',
                        })}
                      </div>
                      {provider === 'github' ? (
                        <>
                          {editing ? (
                            <>
                              {field(
                                'githubAuthentication',
                                <Input
                                  id="source-githubAuthentication"
                                  name="githubAuthenticationDisplay"
                                  className="h-11 text-base sm:text-sm"
                                  value={
                                    githubAuthentication === 'app'
                                      ? 'GitHub App'
                                      : 'Personal access token'
                                  }
                                  readOnly
                                />,
                              )}
                              <input
                                type="hidden"
                                name="githubAuthentication"
                                value={githubAuthentication}
                              />
                            </>
                          ) : (
                            radios(
                              'githubAuthentication',
                              githubAuthentication,
                              [
                                [
                                  'app',
                                  'GitHub App',
                                  'Use an app installation with access to this repository.',
                                ],
                                [
                                  'token',
                                  'Personal access token',
                                  'Add your token after creating the source.',
                                ],
                              ],
                              (value) => setGithubAuthentication(value as 'app' | 'token'),
                            )
                          )}
                          {githubAuthentication === 'app'
                            ? input('config/installationId', {
                                required: true,
                                number: true,
                                minimum: 1,
                              })
                            : null}
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {type === 'composer_repository' ? (
                    <>
                      {input('config/selection/packages', { multiline: true })}
                      {input('config/selection/patterns', { multiline: true })}
                    </>
                  ) : null}
                  {type === 'npm_registry' ? input('config/scopes', { multiline: true }) : null}
                </div>
              ) : null}
              {!editing ? (
                <p className="text-sm text-neutral-600">
                  {proxy
                    ? 'No credentials are needed to add this proxy.'
                    : type === 'vcs' && provider === 'github'
                      ? githubAuthentication === 'app'
                        ? 'After adding this source, save the GitHub App credentials.'
                        : 'After adding this source, save your GitHub personal access token as a bearer credential.'
                      : type === 'vcs' && provider === 'ssh'
                        ? 'After adding this source, save an SSH private key and known hosts.'
                        : 'After adding this source, save its credentials to finish setup.'}
                </p>
              ) : null}
              <details className="min-w-0">
                <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                  Advanced settings
                </summary>
                <div className="grid gap-4 pt-2">
                  <p className="text-sm text-neutral-600">
                    Optional sync, visibility, retention, and connection settings.
                  </p>
                  {editing && proxy
                    ? check(
                        'replaceConfig',
                        'Replace type-specific configuration',
                        setReplaceConfig,
                      )
                    : null}
                  {configEnabled ? (
                    <div className="grid gap-4" key={`advanced:${type}`}>
                      {type === 'composer_repository' || type === 'npm_registry'
                        ? input('config/distHosts', { multiline: true })
                        : null}
                      {type === 'composer_repository' ? (
                        <>
                          {check('config/mirrorsFallback')}
                          {editing ? check('config/selection/expandPatterns') : null}
                        </>
                      ) : null}
                      {type === 'vcs' ? (
                        <>
                          {input('config/packageName')}
                          {input('config/refs/branches', { multiline: true })}
                          {check('config/refs/tags', undefined, undefined, true)}
                        </>
                      ) : null}
                      {type === 'packagist_proxy' && editing ? check('config/githubToken') : null}
                    </div>
                  ) : null}
                  {type === 'packagist_proxy' && editing ? (
                    <p className="text-sm text-neutral-600">
                      To enable Use GitHub token, save a bearer credential with your GitHub token,
                      then replace its configuration.
                    </p>
                  ) : null}
                  {input('pollIntervalSeconds', {
                    number: true,
                    minimum: 1,
                    value: source?.pollIntervalSeconds ?? 300,
                  })}
                  {field(
                    'removalPolicy',
                    <Select
                      id="source-removalPolicy"
                      name="removalPolicy"
                      className="h-11 text-base sm:text-sm"
                      aria-invalid={!!errors.removalPolicy}
                      aria-describedby={describedBy('removalPolicy')}
                      defaultValue={source?.removalPolicy ?? 'flag'}
                    >
                      <option value="flag">Keep available and mark removed</option>
                      <option value="exclude">Exclude from package resolution</option>
                    </Select>,
                  )}
                  {editing
                    ? check(
                        'replaceDefaults',
                        'Replace visibility and retention override',
                        setReplaceDefaults,
                      )
                    : null}
                  {!editing || replaceDefaults ? (
                    <>
                      {check('defaultVisibleToNewProjects')}
                      {input('retentionDaysOverride', { number: true, minimum: 0 })}
                    </>
                  ) : null}
                  {editing && (proxy || type === 'vcs')
                    ? check(
                        'replaceNetwork',
                        type === 'vcs'
                          ? 'Replace User-Agent setting'
                          : 'Replace upstream URL and User-Agent',
                        setReplaceNetwork,
                      )
                    : null}
                  {networkEnabled ? input('userAgent') : null}
                </div>
              </details>
            </fieldset>
          </div>
          <DialogFooter className="shrink-0 border-t border-neutral-200 bg-white px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Button
              className="min-h-11"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button className="min-h-11" disabled={busy}>
              {editing ? 'Save source' : 'Add source'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
