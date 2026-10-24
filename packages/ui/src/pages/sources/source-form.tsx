import { useState, type ReactNode } from 'react';
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
  composer: ['composer_repository', 'vcs', 'packagist_proxy'],
  npm: ['npm_registry', 'npmjs_proxy'],
} as const;
const DEFAULT_URL = {
  packagist_proxy: 'https://repo.packagist.org',
  npmjs_proxy: 'https://registry.npmjs.org',
};
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  ecosystem: 'Ecosystem',
  type: 'Type',
  url: 'Repository URL',
  userAgent: 'User agent',
  pollIntervalSeconds: 'Poll interval (seconds)',
  removalPolicy: 'Removal policy',
  defaultVisibleToNewProjects: 'Visible to new projects',
  retentionDaysOverride: 'Retention override (days; blank inherits)',
  'config/provider': 'Provider',
  'config/repository': 'Repository',
  'config/installationId': 'Installation ID',
  'config/packageName': 'Package name',
  'config/refs/branches': 'Branches (one per line)',
  'config/refs/tags': 'Include tags',
  'config/selection/packages': 'Packages (one per line)',
  'config/selection/patterns': 'Patterns (one per line)',
  'config/selection/expandPatterns': 'Expand patterns',
  'config/distHosts': 'Dist hosts (one per line)',
  'config/mirrorsFallback': 'Mirrors fallback',
  'config/scopes': 'Scopes (one per line)',
  'config/githubToken': 'Use GitHub token',
};

export function sourceFieldErrors(details: ApiErrorDetail[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const detail of details) {
    const path = detail.path.replace(/^\/body\//, '').replace(/^\//, '');
    const field = Object.keys(FIELD_LABELS).find(
      (key) => path === key || path.startsWith(`${key}/`),
    );
    if (field) errors[field] = 'Check this field.';
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
          ...(value('config/provider') === 'github' && value('config/installationId').trim()
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
        if (!editing) changes.config = { githubToken: false };
        break;
      case 'npmjs_proxy':
        changes.config = {};
        break;
    }
  }
  return editing ? changes : { name: value('name'), ecosystem, type, ...changes };
}

export function SourceForm({
  source,
  busy,
  errors,
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
  const [type, setType] = useState<CreateSource['type']>(source?.type ?? 'composer_repository');
  const [provider, setProvider] = useState<'github' | 'git' | 'ssh'>('github');
  const [replaceConfig, setReplaceConfig] = useState(false);
  const [replaceNetwork, setReplaceNetwork] = useState(false);
  const [replaceDefaults, setReplaceDefaults] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const editing = source !== null;
  function field(name: string, control: ReactNode) {
    return (
      <div className="grid gap-1" key={name}>
        <Label htmlFor={`source-${name}`}>{FIELD_LABELS[name]}</Label>
        {control}
        {errors[name] ? (
          <p id={`source-${name}-error`} className="text-sm text-red-700">
            {errors[name]}
          </p>
        ) : null}
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
    } = {},
  ) {
    const props = {
      id: `source-${name}`,
      name,
      required: options.required,
      defaultValue: options.value,
      'aria-invalid': !!errors[name],
      'aria-describedby': errors[name] ? `source-${name}-error` : undefined,
    };
    return field(
      name,
      options.multiline ? (
        <textarea
          {...props}
          rows={3}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
        />
      ) : (
        <Input
          {...props}
          type={options.number ? 'number' : 'text'}
          min={options.minimum}
          max={options.number ? Number.MAX_SAFE_INTEGER : undefined}
          step={options.number ? 1 : undefined}
          maxLength={name === 'url' ? 2048 : undefined}
        />
      ),
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
        <Label className="flex items-center gap-2" htmlFor={`source-${name}`}>
          <input
            type="checkbox"
            id={`source-${name}`}
            name={name}
            defaultChecked={defaultChecked}
            onChange={onChange ? (event) => onChange(event.currentTarget.checked) : undefined}
            aria-invalid={!!errors[name]}
            aria-describedby={errors[name] ? `source-${name}-error` : undefined}
          />
          {label}
        </Label>
        {errors[name] ? (
          <p id={`source-${name}-error`} className="text-sm text-red-700">
            {errors[name]}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit source' : 'Add source'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `${source.name} · name, ecosystem and type cannot be changed.`
              : 'Add an upstream source in the current scope.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid min-w-0 gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setLocalError(null);
            try {
              onSubmit(
                sourceSubmission(new FormData(event.currentTarget), ecosystem, type, editing),
              );
            } catch {
              setLocalError('Enter valid whole numbers for the numeric fields.');
            }
          }}
        >
          {alert || localError ? (
            <p role="alert" className="text-sm text-red-700">
              {localError ?? alert}
            </p>
          ) : null}
          <fieldset disabled={busy} className="grid min-w-0 gap-4">
            {!editing ? (
              <>
                {input('name', { required: true })}
                {field(
                  'ecosystem',
                  <Select
                    id="source-ecosystem"
                    name="ecosystem"
                    value={ecosystem}
                    onChange={(event) => {
                      const next = event.currentTarget.value as CreateSource['ecosystem'];
                      setEcosystem(next);
                      setType(SOURCE_TYPES[next][0]);
                    }}
                  >
                    <option value="composer">composer</option>
                    <option value="npm">npm</option>
                  </Select>,
                )}
                {field(
                  'type',
                  <Select
                    id="source-type"
                    name="type"
                    value={type}
                    onChange={(event) => setType(event.currentTarget.value as CreateSource['type'])}
                  >
                    {SOURCE_TYPES[ecosystem].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>,
                )}
              </>
            ) : null}
            {input('pollIntervalSeconds', {
              required: true,
              number: true,
              minimum: 1,
              value: source?.pollIntervalSeconds ?? 300,
            })}
            {field(
              'removalPolicy',
              <Select
                id="source-removalPolicy"
                name="removalPolicy"
                defaultValue={source?.removalPolicy ?? 'flag'}
              >
                <option value="flag">Flag</option>
                <option value="exclude">Exclude</option>
              </Select>,
            )}
            {editing ? (
              <>
                <p className="text-sm text-neutral-600">
                  The API does not return current configuration, visibility or retention overrides.
                  Select a group to replace it; other groups keep their current values.
                </p>
                {check(
                  'replaceDefaults',
                  'Replace visibility and retention override',
                  setReplaceDefaults,
                )}
              </>
            ) : null}
            {!editing || replaceDefaults ? (
              <>
                {check('defaultVisibleToNewProjects')}
                {input('retentionDaysOverride', { number: true, minimum: 0 })}
              </>
            ) : null}
            {editing
              ? check('replaceNetwork', 'Replace URL and user agent', setReplaceNetwork)
              : null}
            {!editing || replaceNetwork ? (
              <div className="grid gap-4" key={`network:${type}`}>
                {type !== 'vcs'
                  ? input('url', {
                      required: true,
                      value:
                        type in DEFAULT_URL
                          ? DEFAULT_URL[type as keyof typeof DEFAULT_URL]
                          : (source?.url ?? ''),
                    })
                  : null}
                {input('userAgent')}
              </div>
            ) : null}
            {editing && type !== 'packagist_proxy'
              ? check('replaceConfig', 'Replace type-specific configuration', setReplaceConfig)
              : null}
            {type === 'packagist_proxy' ? (
              <div className="grid gap-1">
                <Label className="flex items-center gap-2" htmlFor="source-config/githubToken">
                  <input
                    type="checkbox"
                    id="source-config/githubToken"
                    disabled
                    aria-describedby="packagist-token-help"
                  />
                  Use GitHub token
                </Label>
                <p id="packagist-token-help" className="text-sm text-neutral-600">
                  GitHub token setup is unavailable: the API cannot save the configuration and
                  credential together. New Packagist sources use no token; edits preserve the
                  current token configuration.
                </p>
              </div>
            ) : null}
            {!editing || replaceConfig ? (
              <div className="grid gap-4" key={`config:${type}`}>
                {type === 'vcs' ? (
                  <>
                    {field(
                      'config/provider',
                      <Select
                        id="source-config/provider"
                        name="config/provider"
                        value={provider}
                        onChange={(event) =>
                          setProvider(event.currentTarget.value as typeof provider)
                        }
                      >
                        <option value="github">github</option>
                        <option value="git">git</option>
                        <option value="ssh">ssh</option>
                      </Select>,
                    )}
                    {input('config/repository', { required: true })}
                    {provider === 'github'
                      ? input('config/installationId', { number: true, minimum: 1 })
                      : null}
                    {input('config/packageName')}
                    {input('config/refs/branches', { multiline: true })}
                    {check('config/refs/tags', undefined, undefined, true)}
                  </>
                ) : null}
                {type === 'composer_repository' ? (
                  <>
                    {input('config/selection/packages', { multiline: true })}
                    {input('config/selection/patterns', { multiline: true })}
                    {check('config/selection/expandPatterns')}
                    {check('config/mirrorsFallback')}
                  </>
                ) : null}
                {type === 'npm_registry'
                  ? input('config/scopes', { multiline: true, required: true })
                  : null}
                {type === 'composer_repository' || type === 'npm_registry'
                  ? input('config/distHosts', { multiline: true })
                  : null}

                {type === 'npmjs_proxy' ? (
                  <p className="text-sm text-neutral-600">
                    This type has no configuration fields and takes no credential.
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy}>{editing ? 'Save source' : 'Add source'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
