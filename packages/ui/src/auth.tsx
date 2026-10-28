import { ProductFooter } from './components/product-footer.js';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { ApiClient, ApiErrorCode, ApiRequestDescription, ApiResult } from './api.js';
import type { paths } from './api-types.js';
import {
  loadPending,
  savePending,
  type PendingAction,
  type PendingStorage,
  type PendingDisplay,
} from './pending.js';
import { encodeQr, type QrMatrix } from './qr.js';
import { APP_PATH } from './app-path.js';
import { buildListFilterHash, type HashRoute } from './page-hash.js';
import { Alert, AlertDescription } from './components/ui/alert.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader } from './components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js';
import { CopyButton, IdText } from './components/ui/id-text.js';
import { Input } from './components/ui/input.js';
import { Label } from './components/ui/label.js';

export type AuthClient = ApiClient<paths>;

export interface AuthProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: string;
  readonly supportsReauth: boolean;
}

interface Store<S> {
  snapshot(): S;
  subscribe(listener: () => void): () => void;
}

function createStore<S>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: Partial<S>) {
      state = { ...state, ...next };
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

export function isNavigableLocation(location: string): boolean {
  if (location.startsWith('/')) {
    if (
      location.startsWith('//') ||
      location.includes('\\') ||
      [...location].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return false;
    const base = 'https://broker.invalid';
    return new URL(location, base).origin === base;
  }
  try {
    const { protocol } = new URL(location);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function safePageHash(hash: string): string {
  const match =
    /^#\/(projects|access|sources|packages|tokens|audit|import|login)(?:\?([\s\S]*))?$/.exec(hash);
  if (match === null || match[0] !== hash) return '#/projects';
  const query = new URLSearchParams(match[2]);
  return buildListFilterHash((match[1] === 'login' ? 'projects' : match[1]) as HashRoute, {
    project: query.get('project'),
    status: query.get('status'),
    source: query.get('source'),
    projectId: query.get('projectId'),
    q: query.get('q'),
    after: query.get('after'),
    package: query.get('package'),
    versionAfter: query.get('versionAfter'),
    cursor: query.get('cursor'),
    run: query.get('run'),
    actor: query.get('actor'),
    action: query.get('action'),
    filterProject: query.get('filterProject'),
    limit: query.get('limit'),
  });
}

export function reauthReturnHash(hash: string): string {
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  return safePageHash(`#${query.get('return') ?? '/projects'}`);
}

export type SsoOutcome = 'navigated' | 'refused' | 'failed';

export async function startSso(
  client: AuthClient,
  provider: string,
  purpose: 'login' | 'reauth',
  navigate: (location: string) => void,
  hash?: string,
): Promise<SsoOutcome> {
  const returnHash =
    purpose === 'login'
      ? safePageHash(hash ?? '')
      : `#/reauth?return=${encodeURIComponent(reauthReturnHash(hash ?? '').slice(1))}&sso=complete`;
  const init = {
    params: { provider },
    body: { purpose, ...(hash === undefined ? {} : { returnTo: `/_pb/ui${returnHash}` }) },
    headers: { Accept: 'application/json' },
  };
  const result = await client.request('post', '/_pb/auth/sso/{provider}/start', init as never);
  if (!result.ok) return 'failed';
  const data = result.data as { location?: unknown } | undefined;
  const location = data?.location;
  if (typeof location !== 'string' || !isNavigableLocation(location)) return 'refused';
  navigate(location);
  return 'navigated';
}

function localAuthDisabled(result: ApiResult<unknown>): boolean {
  return !result.ok && result.status === 403 && result.code === 'local_auth_disabled';
}

export interface LoginState {
  readonly status: 'idle' | 'busy' | 'signed-in' | 'error';
  readonly error: 'invalid' | 'unavailable' | 'disabled' | null;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly code: string;
}

export function createLoginController(deps: { client: AuthClient; onSignedIn: () => void }) {
  const store = createStore<LoginState>({ status: 'idle', error: null });
  return {
    snapshot: store.get,
    subscribe: store.subscribe,
    async submit(input: LoginInput): Promise<void> {
      if (store.get().status === 'busy') return;
      store.set({ status: 'busy', error: null });
      const result = await deps.client.request('post', '/_pb/auth/local/login', {
        body: { email: input.email, password: input.password, code: input.code },
      });
      if (result.ok) {
        store.set({ status: 'signed-in', error: null });
        deps.onSignedIn();
        return;
      }
      store.set({
        status: 'error',
        error: localAuthDisabled(result)
          ? 'disabled'
          : result.status === 0
            ? 'unavailable'
            : 'invalid',
      });
    },
  };
}

export interface ReauthState {
  readonly dialog: 'closed' | 'confirm';
  readonly action: PendingAction | null;
  readonly busy: boolean;
  readonly outcome: 'replayed' | 'failed' | 'save-failed' | 'credential-required' | null;
}

export interface ReplayResult {
  readonly createdSourceId?: string;
  readonly path: string;
  readonly ok: boolean;
  readonly status: number;
  readonly code?: ApiErrorCode;
}

export function createReauthFlow(deps: {
  client: AuthClient;
  storage: PendingStorage;
  now: () => number;
  navigate: (hash: string) => void;
}) {
  const replayListeners = new Set<(result: ReplayResult) => void>();
  const store = createStore<ReauthState>({
    dialog: 'closed',
    action: null,
    busy: false,
    outcome: null,
  });
  return {
    snapshot: store.get,
    subscribe: store.subscribe,

    subscribeReplay(listener: (result: ReplayResult) => void) {
      replayListeners.add(listener);
      return () => {
        replayListeners.delete(listener);
      };
    },

    requireReauth(
      request: ApiRequestDescription,
      options: { credential: boolean; secretFields: readonly string[]; display?: PendingDisplay },
      returnHash: string,
    ): void {
      const saved = savePending(deps.storage, {
        method: request.method,
        path: request.path,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(options.display === undefined ? {} : { display: options.display }),
        credential: options.credential,
        secretFields: options.secretFields,
      });
      if (!saved.ok) {
        store.set({ dialog: 'closed', action: null, outcome: 'save-failed' });
        return;
      }
      store.set({ dialog: 'closed', action: null, outcome: null });
      deps.navigate(`#/reauth?return=${encodeURIComponent(safePageHash(returnHash).slice(1))}`);
    },

    restore(): void {
      const loaded = loadPending(deps.storage, deps.now());
      if (loaded.ok && loaded.action !== null) {
        store.set(
          loaded.action.requiresCredential
            ? { dialog: 'closed', action: null, outcome: 'credential-required' }
            : { dialog: 'confirm', action: loaded.action, outcome: null },
        );
      }
    },

    clear(): void {
      loadPending(deps.storage, deps.now());
      store.set({ dialog: 'closed', action: null, busy: false, outcome: null });
    },

    decline(): void {
      store.set({ dialog: 'closed', action: null, outcome: null });
    },

    async confirm(): Promise<void> {
      const { action, busy } = store.get();
      if (action === null || action.requiresCredential || busy) return;
      store.set({ busy: true, action: null });
      const init = {
        ...(action.idempotencyKey === undefined ? {} : { idempotencyKey: action.idempotencyKey }),
        ...(action.body === undefined ? {} : { body: action.body }),
        ...(action.headers === undefined ? {} : { headers: action.headers }),
      };
      const replay = deps.client.request as unknown as (
        method: string,
        path: string,
        init: object,
      ) => Promise<ApiResult<unknown>>;
      let outcome: ReplayResult;
      try {
        const result = await replay(action.method.toLowerCase(), action.path, init);
        outcome = {
          path: action.path,
          ok: result.ok,
          status: result.status,
          ...(!result.ok ? { code: result.code } : {}),
          ...(result.ok &&
          result.status === 201 &&
          action.method === 'POST' &&
          /^\/_pb\/(?:projects\/[^/]+\/)?sources$/.test(action.path) &&
          result.data !== null &&
          typeof result.data === 'object' &&
          'id' in result.data &&
          typeof result.data.id === 'string' &&
          /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(result.data.id)
            ? { createdSourceId: result.data.id }
            : {}),
        };
        store.set({ dialog: 'closed', busy: false, outcome: result.ok ? 'replayed' : 'failed' });
      } catch {
        outcome = { path: action.path, ok: false, status: 0 };
        store.set({ dialog: 'closed', busy: false, outcome: 'failed' });
      }
      for (const listener of replayListeners) listener(outcome);
    },

    async submitLocal(input: {
      password: string;
      code: string;
    }): Promise<'done' | 'refused' | 'disabled'> {
      const result = await deps.client.request('post', '/_pb/auth/local/reauth', {
        body: { password: input.password, code: input.code },
      });
      return result.ok ? 'done' : localAuthDisabled(result) ? 'disabled' : 'refused';
    },
  };
}

export type SetupNotice =
  | 'bad_token_shape'
  | 'token_refused'
  | 'origin_refused'
  | 'rate_limited'
  | 'unavailable'
  | 'password_mismatch'
  | 'missing_fields'
  | 'finish_refused';

export const SETUP_NOTICE_TEXT: Readonly<Record<SetupNotice, string>> = {
  bad_token_shape: 'That does not look like a setup token. Paste the whole token as it was issued.',
  token_refused: 'This setup token was not accepted. It may be wrong, expired or already used.',
  origin_refused: 'The broker refused this request because it came from a different address.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  unavailable: 'The broker could not be reached or answered unexpectedly. Try again in a moment.',
  password_mismatch: 'The password and its confirmation do not match.',
  missing_fields: 'Enter a password and the six digit code from your authenticator.',
  finish_refused:
    'Setup was not completed. Check the password requirements and the six digit code, then try again.',
};

export interface SetupState {
  readonly stage: 'token' | 'enroll' | 'done' | 'uncertain' | 'disabled';
  readonly busy: boolean;
  readonly notice: SetupNotice | null;
  readonly enrollment: { readonly secret: string; readonly qr: QrMatrix | null } | null;
}

const SETUP_TOKEN_LENGTH = 43;
const MAX_FIELD_LENGTH = 1024;

function drawable(uri: string): QrMatrix | null {
  try {
    return encodeQr(uri);
  } catch {
    return null;
  }
}

function startNotice(status: number): SetupNotice {
  if (status === 400 || status === 401) return 'token_refused';
  if (status === 403) return 'origin_refused';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

export function createSetupController(deps: { client: AuthClient; onSignedIn?: () => void }) {
  const store = createStore<SetupState>({
    stage: 'token',
    busy: false,
    notice: null,
    enrollment: null,
  });
  let token: string | null = null;
  return {
    snapshot: store.get,
    subscribe: store.subscribe,

    async submitToken(input: string): Promise<void> {
      const state = store.get();
      if (state.busy || state.stage !== 'token') return;
      const candidate = input.trim();
      if (candidate.length !== SETUP_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(candidate)) {
        store.set({ notice: 'bad_token_shape' });
        return;
      }
      store.set({ busy: true, notice: null });
      const result = await deps.client.request('post', '/_pb/auth/local/setup/start', {
        body: { token: candidate },
      });
      if (localAuthDisabled(result)) {
        token = null;
        store.set({ busy: false, stage: 'disabled', notice: null, enrollment: null });
        return;
      }
      if (!result.ok) {
        store.set({ busy: false, notice: startNotice(result.status) });
        return;
      }
      const data = result.data as { provisioningUri?: unknown; secret?: unknown } | undefined;
      if (
        typeof data?.provisioningUri !== 'string' ||
        typeof data.secret !== 'string' ||
        data.secret === ''
      ) {
        store.set({ busy: false, notice: 'unavailable' });
        return;
      }
      token = candidate;
      store.set({
        busy: false,
        stage: 'enroll',
        notice: null,
        enrollment: { secret: data.secret, qr: drawable(data.provisioningUri) },
      });
    },

    async finish(input: { password: string; confirmation: string; code: string }): Promise<void> {
      const state = store.get();
      if (state.busy || state.stage !== 'enroll' || token === null) return;
      const digits = input.code.replace(/\s+/g, '');
      if (input.password === '' || digits === '') {
        store.set({ notice: 'missing_fields' });
        return;
      }
      if (
        input.password.length > MAX_FIELD_LENGTH ||
        digits.length > MAX_FIELD_LENGTH ||
        input.password !== input.confirmation
      ) {
        store.set({ notice: 'password_mismatch' });
        return;
      }
      store.set({ busy: true, notice: null });
      const result = await deps.client.request('post', '/_pb/auth/local/setup/finish', {
        body: { token, password: input.password, code: digits },
      });
      if (result.ok) {
        token = null;
        store.set({ busy: false, stage: 'done', enrollment: null });
        deps.onSignedIn?.();
        return;
      }
      if (localAuthDisabled(result)) {
        token = null;
        store.set({ busy: false, stage: 'disabled', notice: null, enrollment: null });
        return;
      }
      if (result.status === 0 || result.status >= 500) {
        token = null;
        store.set({ busy: false, stage: 'uncertain', enrollment: null });
        return;
      }
      store.set({
        busy: false,
        notice:
          result.status === 403
            ? 'origin_refused'
            : result.status === 429
              ? 'rate_limited'
              : 'finish_refused',
      });
    },
  };
}

export interface ShellServices {
  readonly onProjectsChanged?: () => void;
  readonly subscribeReplay?: (listener: (result: ReplayResult) => void) => () => void;
  readonly client: AuthClient;
  readonly requireReauth: (
    request: ApiRequestDescription,
    options: { credential: boolean; secretFields: readonly string[]; display?: PendingDisplay },
  ) => void;
}

export const ServicesContext = createContext<ShellServices | null>(null);

export function useServices(): ShellServices {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error('ServicesContext is missing');
  return services;
}

function values(event: FormEvent<HTMLFormElement>): Record<string, string> {
  event.preventDefault();
  const form = event.currentTarget;
  const data: Record<string, string> = {};
  for (const [name, value] of new FormData(form)) if (typeof value === 'string') data[name] = value;
  form.reset();
  return data;
}

function TextField(props: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  inputMode?: 'numeric';
  hint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        name={props.id}
        type={props.type ?? 'text'}
        required
        autoComplete={props.autoComplete ?? 'off'}
        {...(props.inputMode ? { inputMode: props.inputMode } : {})}
        {...(props.hint ? { 'aria-describedby': `${props.id}-hint` } : {})}
      />
      {props.hint ? (
        <p id={`${props.id}-hint`} className="text-xs text-neutral-600">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

const SSO_TEXT: Readonly<Record<'refused' | 'failed', string>> = {
  refused: 'The sign-in provider returned an address the broker will not open.',
  failed: 'Single sign-on could not be started. Try again in a moment.',
};

function SsoButtons(props: {
  providers: readonly AuthProvider[];
  busy: boolean;
  onSso: (provider: string) => void;
  verb: string;
}) {
  if (props.providers.length === 0) return null;
  return (
    <div className="grid gap-2">
      {props.providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onSso(provider.id)}
        >
          {props.verb} {provider.displayName}
        </Button>
      ))}
    </div>
  );
}

function AvailabilityMessage(props: {
  status: 'loading' | 'ready' | 'error';
  local: boolean;
  providers: readonly AuthProvider[];
}) {
  if (props.status === 'loading') return <p role="status">Loading sign-in options…</p>;
  if (props.status === 'error')
    return <p role="alert">Sign-in options could not be loaded. Reload the page to try again.</p>;
  if (!props.local && props.providers.length === 0)
    return <p>Contact your administrator for help signing in.</p>;
  return null;
}

export function LoginView(props: {
  state: LoginState;
  providers: readonly AuthProvider[];
  local: boolean;
  availability?: 'loading' | 'ready' | 'error';
  ssoError?: 'refused' | 'failed' | null;
  onSubmit: (input: LoginInput) => void;
  onSso: (provider: string) => void;
}) {
  const busy = props.state.status === 'busy';
  const local = props.local && props.state.error !== 'disabled';
  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <h1 id="page-heading" tabIndex={-1} className="font-semibold leading-none tracking-tight">
          Sign in
        </h1>
        <CardDescription>Package Broker</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <AvailabilityMessage
          status={props.availability ?? 'ready'}
          local={local}
          providers={props.providers}
        />
        {props.state.error === null || props.state.error === 'disabled' ? null : (
          <Alert variant="destructive">
            <AlertDescription>
              {props.state.error === 'unavailable'
                ? 'The broker could not be reached. Try again in a moment.'
                : 'Sign-in failed. Check your details and try again.'}
            </AlertDescription>
          </Alert>
        )}
        {props.ssoError ? (
          <Alert variant="destructive">
            <AlertDescription>{SSO_TEXT[props.ssoError]}</AlertDescription>
          </Alert>
        ) : null}
        {local && (props.availability ?? 'ready') === 'ready' ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const data = values(event);
              props.onSubmit({
                email: data['email'] ?? '',
                password: data['password'] ?? '',
                code: (data['code'] ?? '').replace(/\s+/g, ''),
              });
            }}
          >
            <TextField id="email" label="E-mail" type="email" autoComplete="username" />
            <TextField
              id="password"
              label="Password"
              type="password"
              autoComplete="current-password"
            />
            <TextField
              id="code"
              label="Authenticator code"
              autoComplete="one-time-code"
              inputMode="numeric"
            />
            <Button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        ) : null}
        <SsoButtons
          providers={props.providers}
          busy={busy}
          onSso={props.onSso}
          verb="Sign in with"
        />
      </CardContent>
    </Card>
  );
}

export function ReauthView(props: {
  providers: readonly AuthProvider[];
  local: boolean;
  availability?: 'loading' | 'ready' | 'error';
  error: boolean;
  busy: boolean;
  onSubmit: (input: { password: string; code: string }) => void;
  onSso: (provider: string) => void;
}) {
  const providers = props.providers.filter((provider) => provider.supportsReauth);
  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <h1 id="page-heading" tabIndex={-1} className="font-semibold leading-none tracking-tight">
          Confirm it is you
        </h1>
        <CardDescription>This action needs a fresh sign-in.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <AvailabilityMessage
          status={props.availability ?? 'ready'}
          local={props.local}
          providers={providers}
        />
        {props.error ? (
          <Alert variant="destructive">
            <AlertDescription>
              Confirmation failed. Check your details and try again.
            </AlertDescription>
          </Alert>
        ) : null}
        {props.local && (props.availability ?? 'ready') === 'ready' ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (props.busy) return;
              const data = values(event);
              props.onSubmit({
                password: data['password'] ?? '',
                code: (data['code'] ?? '').replace(/\s+/g, ''),
              });
            }}
          >
            <TextField
              id="password"
              label="Password"
              type="password"
              autoComplete="current-password"
            />
            <TextField
              id="code"
              label="Authenticator code"
              autoComplete="one-time-code"
              inputMode="numeric"
            />
            <Button type="submit" disabled={props.busy}>
              Confirm
            </Button>
          </form>
        ) : null}
        <SsoButtons
          providers={providers}
          busy={props.busy}
          onSso={props.onSso}
          verb="Confirm with"
        />
        {!props.local && (props.availability ?? 'ready') === 'ready' && providers.length > 0 ? (
          <p>
            Signed in with a password? Sign out and sign in with{' '}
            {providers.map((provider) => provider.displayName).join(' or ')} to continue.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ReauthConfirmDialog(props: {
  open: boolean;
  action: PendingAction | null;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onDecline();
      }}
    >
      <DialogContent>
        <ReauthConfirmContent {...props} />
      </DialogContent>
    </Dialog>
  );
}

function restoredProjectSlug(action: PendingAction | null) {
  return action?.path.match(/^\/_pb\/projects\/([^/]+)\/restore$/)?.[1];
}

export function pendingActionDescription(action: PendingAction | null) {
  if (restoredProjectSlug(action)) {
    return {
      label: 'Restore project',
      effect: 'Restore this archived project.',
      destructive: false,
    };
  }
  const match = action?.path.match(
    /\/(quarantine|tombstone|release|approve|apply|cancel|rollback)$/,
  );
  const verb = match?.[1];
  const labels: Record<string, string> = {
    quarantine: 'Quarantine version',
    tombstone: 'Tombstone version',
    release: 'Release version',
    approve: 'Approve import run',
    apply: 'Apply import run',
    cancel: 'Cancel import run',
    rollback: 'Roll back import run',
  };
  const effects: Record<string, string> = {
    quarantine:
      'Clients cannot resolve this version until it is released. Only this version is affected.',
    tombstone:
      'Clients can no longer install this version. Only this version is affected. This cannot be undone.',
    release: 'Clients can resolve this version again. Only this version is affected.',
    approve: 'Approve the reviewed plan hash for this run.',
    apply: 'Apply the approved import plan.',
    cancel: 'Cancel this planned import run.',
    rollback: 'Restore retained before-images where rollback is possible.',
  };
  return {
    label: verb ? (labels[verb] ?? 'Send held action') : 'Send held action',
    effect: verb
      ? (effects[verb] ?? 'Send the request you started before confirming your identity.')
      : 'Send the request you started before confirming your identity.',
    destructive: ['tombstone', 'cancel', 'rollback'].includes(verb ?? ''),
  };
}

export function ReauthConfirmContent(props: {
  action: PendingAction | null;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const description = pendingActionDescription(props.action);
  const display = props.action?.display;
  const projectSlug = restoredProjectSlug(props.action);
  const packageIds = props.action?.path.match(/\/packages\/([^/]+)\/versions\/([^/]+)/);
  const runId = props.action?.path.match(/\/import-runs\/([^/]+)/)?.[1];
  const request = props.action ? `${props.action.method} ${props.action.path}` : '';
  return (
    <>
      <DialogHeader>
        <DialogTitle>Send the held action now?</DialogTitle>
        <DialogDescription>
          You confirmed your identity. The action below was held while you signed in and has not
          been sent yet.
        </DialogDescription>
      </DialogHeader>
      <dl className="detail-list">
        <dt>Action</dt>
        <dd className="font-medium">{description.label}</dd>
        {projectSlug ? (
          <>
            <dt>Project</dt>
            <dd>{projectSlug}</dd>
          </>
        ) : null}
        {display ? (
          <>
            <dt>Package</dt>
            <dd>{display.packageName}</dd>
            <dt>Version</dt>
            <dd className="font-mono">{display.version}</dd>
          </>
        ) : packageIds ? (
          <>
            <dt>Package ID</dt>
            <dd>
              <IdText value={packageIds[1]!} label="package ID" />
            </dd>
            <dt>Version ID</dt>
            <dd>
              <IdText value={packageIds[2]!} label="version ID" />
            </dd>
          </>
        ) : null}
        {runId ? (
          <>
            <dt>Run</dt>
            <dd>
              <IdText value={runId} label="run ID" />
            </dd>
          </>
        ) : null}
        <dt>Scope</dt>
        <dd>
          {display?.scope ??
            (props.action?.path.startsWith('/_pb/projects/') ? 'Project' : 'Organization')}
        </dd>
        <dt>Effect</dt>
        <dd>{description.effect}</dd>
      </dl>
      {request ? (
        <details>
          <summary className="cursor-pointer text-sm text-blue-700">Request details</summary>
          <div className="mt-2 flex min-w-0 items-start gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
            <code className="min-w-0 break-all text-xs">{request}</code>
            <CopyButton value={request} label="Copy request" />
          </div>
        </details>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onDecline}>
          Discard
        </Button>
        <Button
          type="button"
          variant={description.destructive ? 'destructive' : 'default'}
          onClick={props.onConfirm}
        >
          {description.label}
        </Button>
      </DialogFooter>
    </>
  );
}

const QR_QUIET_ZONE = 4;

function QrImage({ matrix }: { matrix: QrMatrix }) {
  const size = matrix.size + QR_QUIET_ZONE * 2;
  const cells: string[] = [];
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) cells.push(`M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`);
    });
  });
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${size} ${size}`}
      width="192"
      height="192"
      role="img"
      aria-label="Authenticator QR code"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={cells.join('')} fill="#000000" />
    </svg>
  );
}

export function SetupView(props: {
  state: SetupState;
  onToken: (token: string) => void;
  onFinish: (input: { password: string; confirmation: string; code: string }) => void;
}) {
  const { state } = props;
  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <h1 id="page-heading" tabIndex={-1} className="font-semibold leading-none tracking-tight">
          First-run setup
        </h1>
      </CardHeader>
      <CardContent className="grid gap-4">
        {state.notice === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{SETUP_NOTICE_TEXT[state.notice]}</AlertDescription>
          </Alert>
        )}
        {state.stage === 'token' ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (state.busy) return;
              props.onToken(values(event)['token'] ?? '');
            }}
          >
            <TextField
              id="token"
              label="Setup token"
              hint="Paste the token the broker printed at start."
            />
            <Button type="submit" disabled={state.busy}>
              Continue
            </Button>
          </form>
        ) : null}
        {state.stage === 'enroll' && state.enrollment ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (state.busy) return;
              const data = values(event);
              props.onFinish({
                password: data['password'] ?? '',
                confirmation: data['confirmation'] ?? '',
                code: data['code'] ?? '',
              });
            }}
          >
            {state.enrollment.qr ? <QrImage matrix={state.enrollment.qr} /> : null}
            <p className="text-sm">
              Setup key: <code className="break-all">{state.enrollment.secret}</code>
            </p>
            <TextField id="password" label="Password" type="password" autoComplete="new-password" />
            <TextField
              id="confirmation"
              label="Confirm password"
              type="password"
              autoComplete="new-password"
            />
            <TextField
              id="code"
              label="Authenticator code"
              autoComplete="one-time-code"
              inputMode="numeric"
            />
            <Button type="submit" disabled={state.busy}>
              Finish setup
            </Button>
          </form>
        ) : null}
        {state.stage === 'done' ? <p>Setup is complete. You can now sign in.</p> : null}
        {state.stage === 'uncertain' ? (
          <p>
            The broker did not confirm the result. Try signing in; if that fails, ask for a fresh
            setup token.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function useProviders(client: AuthClient) {
  const [state, setState] = useState<{
    client: AuthClient;
    providers: AuthProvider[];
    local: boolean;
    availability: 'loading' | 'ready' | 'error';
  }>({ client, providers: [], local: false, availability: 'loading' });
  useEffect(() => {
    let live = true;
    void client
      .request('get', '/_pb/auth/providers')
      .then((result) => {
        if (!live) return;
        if (
          result.ok &&
          result.data &&
          typeof result.data.local === 'boolean' &&
          Array.isArray(result.data.providers)
        ) {
          setState({
            client,
            providers: result.data.providers,
            local: result.data.local,
            availability: 'ready',
          });
        } else {
          setState({ client, providers: [], local: false, availability: 'error' });
        }
      })
      .catch(() => {
        if (live) setState({ client, providers: [], local: false, availability: 'error' });
      });
    return () => {
      live = false;
    };
  }, [client]);
  return state.client === client
    ? state
    : { providers: [], local: false, availability: 'loading' as const };
}

const assignLocation = (location: string): void => {
  window.location.assign(location);
};

export function LoginScreen(props: { client: AuthClient; onSignedIn: () => void }) {
  const { client, onSignedIn } = props;
  const controller = useMemo(
    () => createLoginController({ client, onSignedIn }),
    [client, onSignedIn],
  );
  const state = useStore(controller);
  const { providers, local, availability } = useProviders(client);
  const [ssoError, setSsoError] = useState<'refused' | 'failed' | null>(null);
  return (
    <LoginView
      state={state}
      providers={providers}
      local={local}
      availability={availability}
      ssoError={ssoError}
      onSubmit={(input) => void controller.submit(input)}
      onSso={(provider) => {
        setSsoError(null);
        void startSso(client, provider, 'login', assignLocation, window.location.hash).then(
          (outcome) => {
            if (outcome !== 'navigated') setSsoError(outcome);
          },
        );
      }}
    />
  );
}

export function SetupAvailabilityView(props: {
  availability: 'loading' | 'ready' | 'error';
  local: boolean;
  providers: readonly AuthProvider[];
}) {
  return (
    <div className="mx-auto mt-12 max-w-md grid gap-4">
      <h1 id="page-heading" tabIndex={-1} className="font-semibold">
        {props.availability === 'error'
          ? 'Setup is unavailable'
          : props.availability === 'ready'
            ? "Sign in with your organization's account"
            : 'First-run setup'}
      </h1>
      <AvailabilityMessage
        status={props.availability}
        local={props.local}
        providers={props.providers}
      />
      {props.availability === 'ready' ? (
        <p>Password setup is unavailable. Sign in to continue.</p>
      ) : null}
      <a href={`${APP_PATH}#/login`}>Go to sign in</a>
    </div>
  );
}

export function SetupScreen(props: { client: AuthClient; onSignedIn: () => void }) {
  const { client, onSignedIn } = props;
  const controller = useMemo(
    () => createSetupController({ client, onSignedIn }),
    [client, onSignedIn],
  );
  const state = useStore(controller);
  const { providers, local, availability } = useProviders(client);
  if (availability !== 'ready' || !local || state.stage === 'disabled')
    return (
      <SetupAvailabilityView availability={availability} local={false} providers={providers} />
    );
  return (
    <SetupView
      state={state}
      onToken={(token) => void controller.submitToken(token)}
      onFinish={(input) => void controller.finish(input)}
    />
  );
}

export function ReauthScreen(props: {
  client: AuthClient;
  flow: ReturnType<typeof createReauthFlow>;
  onDone: () => void;
}) {
  const { client, flow, onDone } = props;
  const { providers, local, availability } = useProviders(client);
  const [error, setError] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <ReauthView
      providers={providers}
      local={local && !disabled}
      availability={availability}
      error={error}
      busy={busy}
      onSubmit={(input) => {
        setBusy(true);
        setError(false);
        void flow.submitLocal(input).then((outcome) => {
          setBusy(false);
          if (outcome === 'done') {
            flow.restore();
            onDone();
          } else if (outcome === 'disabled') {
            setDisabled(true);
          } else {
            setError(true);
          }
        });
      }}
      onSso={(provider) => {
        setError(false);
        void startSso(client, provider, 'reauth', assignLocation, window.location.hash).then(
          (outcome) => {
            if (outcome !== 'navigated') setError(true);
          },
        );
      }}
    />
  );
}

export function ReauthConfirm(props: { flow: ReturnType<typeof createReauthFlow> }) {
  const state = useStore(props.flow);
  if (
    state.outcome === 'save-failed' ||
    state.outcome === 'failed' ||
    state.outcome === 'credential-required'
  ) {
    return (
      <Alert variant="destructive" className="mx-auto my-4 max-w-lg">
        <AlertDescription>
          {state.outcome === 'credential-required'
            ? 'Enter the credential again to complete your action.'
            : state.outcome === 'save-failed'
              ? 'Your action could not be saved. Try the action again after dismissing this message.'
              : 'Your action could not be completed. Review the current data and try the action again.'}
        </AlertDescription>
        <Button type="button" variant="outline" onClick={() => props.flow.decline()}>
          Dismiss
        </Button>
      </Alert>
    );
  }
  return (
    <ReauthConfirmDialog
      open={state.dialog === 'confirm'}
      action={state.action}
      onConfirm={() => void props.flow.confirm()}
      onDecline={() => props.flow.decline()}
    />
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex-1 px-4">{children}</main>
      <ProductFooter />
    </div>
  );
}
