import { useEffect, useId, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Textarea } from '../components/ui/textarea.js';
import {
  EVENT_CHOICES,
  type ActionOutcome,
  type Endpoint,
  type EventType,
  type Options,
  type Secret,
} from './notification-actions.js';

const EXAMPLE_IDS = {
  id: '01JEXAMPLEEVENT00000000000',
  operationId: '01JEXAMPLE0PERATI0N0000000',
  organizationId: '01JEXAMPLE0RGANIZATI0N0000',
  projectId: '01JEXAMPLEPR0JECT000000000',
};

const EXAMPLE_DATA: Readonly<Record<EventType, Record<string, unknown>>> = {
  'npm.package.published': {},
  'npm.package.released': { releaseCause: 'approval_and_scan' },
  'npm.package.unpublished': { removalScope: 'version', removalKind: 'window' },
  'npm.package.deprecation_changed': { deprecated: true },
  'npm.package.dist_tag_changed': {
    tag: 'latest',
    previousVersion: '1.2.2',
    version: '1.2.3',
    cause: 'explicit',
  },
};

/** The canonical envelope for made-up package data; nothing is sent or fetched. */
export function exampleEnvelope(type: EventType) {
  return {
    schemaVersion: 1,
    ...EXAMPLE_IDS,
    type,
    occurredAt: '2026-11-01T12:00:00.000Z',
    package: { ecosystem: 'npm', name: '@example/library', version: '1.2.3' },
    data: EXAMPLE_DATA[type],
  };
}

function lookup(envelope: unknown, path: string): unknown {
  let value: unknown = envelope;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * A local approximation of json-v1 rendering for the preview: a whole-string `{{path}}` value is
 * replaced by the example value. The broker validates the template when it is saved.
 */
export function previewBody(type: EventType, template: string): string {
  const envelope = exampleEnvelope(type);
  if (template.trim() === '') return JSON.stringify(envelope, null, 2);
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch {
    return 'The template is not valid JSON.';
  }
  let missing = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
    const match = typeof value === 'string' ? /^\{\{([A-Za-z.]+)\}\}$/.exec(value) : null;
    if (match === null) return value;
    const found = lookup(envelope, match[1]!);
    if (found === undefined || (found !== null && typeof found === 'object')) missing = true;
    return found;
  };
  const rendered = walk(parsed);
  return missing
    ? 'The template names a value this event does not have.'
    : JSON.stringify(rendered, null, 2);
}

interface Header {
  readonly name: string;
  readonly value: string;
}
const NO_SECRET = { url: '', signingKey: '', template: '', headers: [] as readonly Header[] };

export function NotificationForm(props: {
  projectName: string;
  endpoint: Endpoint | null;
  disabled: boolean;
  restoredOptions?: Options;
  requireSecret?: boolean;
  onSubmit: (change: { options: Options; secret?: Secret }) => Promise<ActionOutcome>;
  onCancel: () => void;
}) {
  const ids = useId();
  const editing = props.endpoint;
  const [options, setOptions] = useState<Options>(
    () =>
      props.restoredOptions ?? {
        name: editing?.name ?? '',
        method: editing?.method ?? 'POST',
        events: [...(editing?.events ?? ['npm.package.published'])],
        packagePattern: editing?.packagePattern ?? '*',
      },
  );
  const [replacing, setReplacing] = useState(editing === null || props.requireSecret === true);
  const [secret, setSecret] = useState(NO_SECRET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => () => setSecret(NO_SECRET), []);
  const eventsChanged =
    editing !== null && [...options.events].sort().join() !== [...editing.events].sort().join();
  const templateBlocks = editing?.templateConfigured === true && eventsChanged && !replacing;
  const id = (name: string) => `${ids}-${name}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || props.disabled) return;
    if (options.events.length === 0) {
      setError('Choose at least one event.');
      document.getElementById(id('events'))?.focus();
      return;
    }
    if (templateBlocks) {
      setError(
        'This endpoint has a body template. Replace the delivery settings with a template that fits the new events.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await props.onSubmit({
      options,
      ...(replacing
        ? {
            secret: {
              url: secret.url,
              signingKey: secret.signingKey,
              headers: secret.headers.filter((header) => header.name !== ''),
              template: secret.template.trim() === '' ? null : secret.template,
            },
          }
        : {}),
    });
    setBusy(false);
    if (outcome.ok || outcome.reauth) {
      setSecret(NO_SECRET);
      setPreview(null);
    }
    if (!outcome.ok) setError(outcome.message);
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label={editing === null ? 'New notification endpoint' : `Edit ${editing.name}`}
      className="grid max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2"
    >
      <h3 className="text-lg font-semibold lg:col-span-2">
        {editing === null ? 'New notification endpoint' : `Edit ${editing.name}`}
      </h3>
      <p className="lg:col-span-2">
        {`Project ${props.projectName} · The broker sends a signed HTTPS request to your receiver when a selected package event commits in this project.`}
      </p>
      <div className="grid gap-1">
        <Label htmlFor={id('name')}>Name</Label>
        <Input
          id={id('name')}
          required
          maxLength={80}
          value={options.name}
          onChange={(event) => setOptions({ ...options, name: event.target.value })}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={id('pattern')}>Package filter</Label>
        <Input
          id={id('pattern')}
          required
          maxLength={50}
          value={options.packagePattern}
          aria-describedby={id('pattern-help')}
          onChange={(event) => setOptions({ ...options, packagePattern: event.target.value })}
        />
        <p id={id('pattern-help')} className="text-sm text-neutral-600">
          * matches any characters, including /. Examples: * for every package, @acme/* for one
          scope. Matching is exact and case-sensitive on the stored name; legacy package names with
          capital letters are stored with each capital written as ! followed by the lower-case
          letter, for example !my!package for MyPackage.
        </p>
      </div>
      <fieldset
        id={id('events')}
        tabIndex={-1}
        className="grid gap-2 lg:col-span-2"
        aria-describedby={id('events-help')}
      >
        <legend className="font-medium">Events</legend>
        <p id={id('events-help')} className="text-sm text-neutral-600">
          Only events committed after the endpoint is enabled are sent.
        </p>
        {EVENT_CHOICES.map((choice) => (
          <label key={choice.value} className="flex min-h-11 items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={options.events.includes(choice.value)}
              onChange={(event) =>
                setOptions({
                  ...options,
                  events: event.target.checked
                    ? [...options.events, choice.value]
                    : options.events.filter((value) => value !== choice.value),
                })
              }
            />
            <span>
              <span className="font-medium">{choice.label}</span>
              <span className="block text-sm text-neutral-600">{choice.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-2 lg:col-span-2">
        <legend className="font-medium">Request method</legend>
        {(['POST', 'PUT'] as const).map((method) => (
          <label key={method} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name={id('method')}
              checked={options.method === method}
              onChange={() => setOptions({ ...options, method })}
            />
            {method}
          </label>
        ))}
      </fieldset>
      {editing === null ? null : (
        <div className="grid gap-2 lg:col-span-2">
          <p>
            {`Delivery settings: destination configured, signing key configured, custom headers ${editing.headersConfigured ? 'configured' : 'none'}, body template ${editing.templateConfigured ? 'configured' : 'none (standard envelope)'}. Saved settings are never shown again.`}
          </p>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={replacing}
              onChange={(event) => {
                setReplacing(event.target.checked);
                if (!event.target.checked) setSecret(NO_SECRET);
              }}
            />
            Replace delivery settings (needs recent sign-in; disables the endpoint)
          </label>
        </div>
      )}
      {!replacing ? null : (
        <fieldset className="grid gap-4 lg:col-span-2 lg:grid-cols-2">
          <legend className="font-medium">Delivery settings</legend>
          <div className="grid gap-1 lg:col-span-2">
            <Label htmlFor={id('url')}>Destination URL</Label>
            <Input
              id={id('url')}
              type="url"
              required
              autoComplete="off"
              maxLength={2048}
              value={secret.url}
              aria-describedby={id('url-help')}
              onChange={(event) => setSecret({ ...secret, url: event.target.value })}
            />
            <p id={id('url-help')} className="text-sm text-neutral-600">
              HTTPS on port 443 to a public host. Redirects are not followed. The address is stored
              sealed and never shown again, so tokens in the path or query stay private.
            </p>
          </div>
          <div className="grid gap-1 lg:col-span-2">
            <Label htmlFor={id('key')}>Signing key</Label>
            <Input
              id={id('key')}
              type="password"
              required
              autoComplete="off"
              pattern="[A-Za-z0-9_\-]{43}"
              value={secret.signingKey}
              aria-describedby={id('key-help')}
              onChange={(event) => setSecret({ ...secret, signingKey: event.target.value })}
            />
            <p id={id('key-help')} className="text-sm text-neutral-600">
              32 random bytes as 43 base64url characters, shared with your receiver to verify the
              X-Package-Broker-Signature header.
            </p>
          </div>
          <div className="grid gap-2 lg:col-span-2">
            <p className="font-medium">Custom headers (optional)</p>
            <p className="text-sm text-neutral-600">
              Authorization or X- headers only, up to 16. Values are stored sealed.
            </p>
            {secret.headers.map((header, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <div className="grid gap-1">
                  <Label htmlFor={id(`header-name-${index}`)}>Header name</Label>
                  <Input
                    id={id(`header-name-${index}`)}
                    value={header.name}
                    autoComplete="off"
                    onChange={(event) =>
                      setSecret({
                        ...secret,
                        headers: secret.headers.map((item, at) =>
                          at === index ? { ...item, name: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={id(`header-value-${index}`)}>Header value</Label>
                  <Input
                    id={id(`header-value-${index}`)}
                    type="password"
                    value={header.value}
                    autoComplete="off"
                    onChange={(event) =>
                      setSecret({
                        ...secret,
                        headers: secret.headers.map((item, at) =>
                          at === index ? { ...item, value: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-end"
                  onClick={() =>
                    setSecret({
                      ...secret,
                      headers: secret.headers.filter((_, at) => at !== index),
                    })
                  }
                >
                  Remove header
                </Button>
              </div>
            ))}
            {secret.headers.length < 16 ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                onClick={() =>
                  setSecret({ ...secret, headers: [...secret.headers, { name: '', value: '' }] })
                }
              >
                Add header
              </Button>
            ) : null}
          </div>
          <div className="grid gap-1 lg:col-span-2">
            <Label htmlFor={id('template')}>Body template (optional)</Label>
            <Textarea
              id={id('template')}
              rows={5}
              maxLength={8192}
              value={secret.template}
              aria-describedby={id('template-help')}
              onChange={(event) => setSecret({ ...secret, template: event.target.value })}
            />
            <p id={id('template-help')} className="text-sm text-neutral-600">
              Leave empty to send the standard event envelope. A template is JSON in which a string
              value written as {'"{{package.name}}"'} is replaced by that event value. It must fit
              every selected event.
            </p>
          </div>
          <div className="grid gap-2 lg:col-span-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              disabled={options.events.length === 0}
              onClick={() => setPreview(previewBody(options.events[0]!, secret.template))}
            >
              Preview with example data
            </Button>
            {preview === null ? null : (
              <pre
                aria-label="Example body"
                className="max-h-64 overflow-auto rounded-md border bg-neutral-50 p-2 text-xs"
              >
                {preview}
              </pre>
            )}
          </div>
        </fieldset>
      )}
      {templateBlocks ? (
        <Alert className="lg:col-span-2">
          <AlertDescription>
            This endpoint has a body template checked against its current events. To change the
            events, replace the delivery settings with a template that fits them.
          </AlertDescription>
        </Alert>
      ) : null}
      <p className="lg:col-span-2">
        {editing === null
          ? 'The endpoint is added disabled. Adding it needs a recent sign-in. Nothing is sent until you enable it.'
          : 'Saving any change, including a rename, starts a new revision and cancels deliveries still waiting for the previous one.'}
      </p>
      {error === null ? null : (
        <p role="alert" className="text-red-700 lg:col-span-2">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 lg:col-span-2">
        <Button
          type="submit"
          className="min-h-11 w-full sm:w-auto"
          disabled={busy || props.disabled}
          aria-busy={busy}
        >
          {busy
            ? editing === null
              ? 'Adding endpoint…'
              : 'Saving endpoint…'
            : editing === null
              ? 'Add endpoint'
              : 'Save endpoint'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
          disabled={busy}
          onClick={() => {
            setSecret(NO_SECRET);
            props.onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
