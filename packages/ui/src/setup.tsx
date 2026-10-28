import { encodeQr, type QrMatrix } from './qr.js';
import { APP_PATH } from './app-path.js';

export const SETUP_START_PATH = '/_pb/auth/local/setup/start';
export const SETUP_FINISH_PATH = '/_pb/auth/local/setup/finish';
export { APP_PATH } from './app-path.js';

const SETUP_TOKEN_LENGTH = 43;
const MAX_FIELD_LENGTH = 1024;

export type SetupStage =
  'checking' | 'disabled' | 'unavailable' | 'token' | 'enroll' | 'done' | 'uncertain';

export type PasswordProblem = 'too_short' | 'too_long' | 'equals_email' | 'not_well_formed';

export type SetupNotice =
  | 'bad_token_shape'
  | 'token_refused'
  | 'origin_refused'
  | 'rate_limited'
  | 'unavailable'
  | 'password_mismatch'
  | 'missing_fields'
  | 'weak_password'
  | 'finish_refused'
  | 'qr_unavailable';

export interface SetupEnrollment {
  readonly provisioningUri: string;
  readonly secret: string;
  readonly qr: QrMatrix | null;
}

export interface SetupSnapshot {
  readonly stage: SetupStage;
  readonly busy: boolean;
  readonly notice: SetupNotice | null;
  readonly problems: readonly PasswordProblem[];
  readonly enrollment: SetupEnrollment | null;
}

export interface SetupResponse {
  readonly status: number;
  readonly json: unknown;
}

export interface SetupTransport {
  get(path: string): Promise<SetupResponse>;
  post(path: string, body: Readonly<Record<string, string>>): Promise<SetupResponse>;
}

export interface SetupController {
  snapshot(): SetupSnapshot;
  subscribe(listener: () => void): () => void;
  submitToken(token: string): Promise<void>;
  finish(input: {
    readonly password: string;
    readonly confirmation: string;
    readonly code: string;
  }): Promise<void>;
  dispose(): void;
}

const PASSWORD_PROBLEMS: readonly string[] = [
  'too_short',
  'too_long',
  'equals_email',
  'not_well_formed',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function passwordProblemsOf(json: unknown): PasswordProblem[] | null {
  if (!isRecord(json) || !isRecord(json['error'])) return null;
  const error = json['error'];
  if (error['code'] !== 'weak_password' || !Array.isArray(error['problems'])) return null;
  const known = error['problems'].filter(
    (problem): problem is PasswordProblem =>
      typeof problem === 'string' && PASSWORD_PROBLEMS.includes(problem),
  );
  return known.length > 0 ? known : null;
}

function renderQr(uri: string): QrMatrix | null {
  try {
    return encodeQr(uri);
  } catch {
    return null;
  }
}

export function createSetupController(deps: {
  readonly transport: SetupTransport;
}): SetupController {
  const { transport } = deps;
  const listeners = new Set<() => void>();
  let token: string | null = null;
  let view: SetupSnapshot = {
    stage: 'checking',
    busy: false,
    notice: null,
    problems: [],
    enrollment: null,
  };
  let disposed = false;

  const publish = (next: Partial<SetupSnapshot>): void => {
    if (disposed) return;
    view = { ...view, ...next };
    for (const listener of [...listeners]) listener();
  };

  const clearSecrets = (): void => {
    token = null;
  };

  const send = async (
    path: string,
    body: Readonly<Record<string, string>>,
  ): Promise<SetupResponse | null> => {
    try {
      return await transport.post(path, body);
    } catch {
      return null;
    }
  };

  void transport
    .get('/_pb/auth/providers')
    .then((response) => {
      if (disposed) return;
      const body = response.json;
      publish({
        stage:
          response.status === 200 && isRecord(body) && typeof body['local'] === 'boolean'
            ? body['local']
              ? 'token'
              : 'disabled'
            : 'unavailable',
      });
    })
    .catch(() => publish({ stage: 'unavailable' }));

  return {
    snapshot: () => view,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async submitToken(input) {
      if (view.busy || view.stage !== 'token') return;
      const candidate = input.trim();
      if (candidate.length !== SETUP_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(candidate)) {
        publish({ notice: 'bad_token_shape' });
        return;
      }
      publish({ busy: true, notice: null });
      const response = await send(SETUP_START_PATH, { token: candidate });
      if (response === null) {
        publish({ busy: false, notice: 'unavailable' });
        return;
      }
      if (response.status === 200) {
        const body = response.json;
        if (
          isRecord(body) &&
          typeof body['provisioningUri'] === 'string' &&
          typeof body['secret'] === 'string' &&
          body['secret'].length > 0
        ) {
          token = candidate;
          const qr = renderQr(body['provisioningUri']);
          publish({
            busy: false,
            stage: 'enroll',
            notice: qr === null ? 'qr_unavailable' : null,
            enrollment: { provisioningUri: body['provisioningUri'], secret: body['secret'], qr },
          });
          return;
        }
        publish({ busy: false, notice: 'unavailable' });
        return;
      }
      publish({ busy: false, notice: noticeForStart(response.status) });
    },

    async finish(input) {
      if (view.busy || view.stage !== 'enroll' || token === null) return;
      const { password, confirmation, code } = input;
      const digits = code.replace(/\s+/g, '');
      if (password.length === 0 || digits.length === 0) {
        publish({ notice: 'missing_fields', problems: [] });
        return;
      }
      if (
        password.length > MAX_FIELD_LENGTH ||
        digits.length > MAX_FIELD_LENGTH ||
        password !== confirmation
      ) {
        publish({ notice: 'password_mismatch', problems: [] });
        return;
      }
      publish({ busy: true, notice: null, problems: [] });
      const response = await send(SETUP_FINISH_PATH, { token, password, code: digits });
      if (response === null || response.status >= 500) {
        clearSecrets();
        publish({ busy: false, stage: 'uncertain', notice: null, enrollment: null });
        return;
      }
      if (response.status === 204) {
        clearSecrets();
        publish({ busy: false, stage: 'done', notice: null, enrollment: null });
        return;
      }
      const problems = response.status === 400 ? passwordProblemsOf(response.json) : null;
      if (problems !== null) {
        publish({ busy: false, notice: 'weak_password', problems });
        return;
      }
      if (response.status === 403) {
        publish({ busy: false, notice: 'origin_refused' });
        return;
      }
      if (response.status === 429) {
        publish({ busy: false, notice: 'rate_limited' });
        return;
      }
      publish({ busy: false, notice: 'finish_refused' });
    },

    dispose() {
      clearSecrets();
      disposed = true;
      view = { ...view, enrollment: null, problems: [], busy: false };
      listeners.clear();
    },
  };
}

function noticeForStart(status: number): SetupNotice {
  if (status === 401 || status === 400) return 'token_refused';
  if (status === 403) return 'origin_refused';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

export function createFetchTransport(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): SetupTransport {
  return {
    async get(path) {
      const response = await fetchImpl(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        ...(signal === undefined ? {} : { signal }),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    async post(path, body) {
      const response = await fetchImpl(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        ...(signal === undefined ? {} : { signal }),
      });
      const json: unknown = await response.json().catch(() => null);
      return { status: response.status, json };
    },
  };
}

export const NOTICE_TEXT: Readonly<Record<SetupNotice, string>> = {
  bad_token_shape:
    'That does not look like a setup token. Paste the whole token exactly as it was issued.',
  token_refused:
    'This setup token was not accepted. It may be wrong, expired or already used. Ask the person who runs the broker for a fresh token.',
  origin_refused: 'The broker refused this request because it came from a different address.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  unavailable: 'The broker could not be reached or answered unexpectedly. Try again in a moment.',
  password_mismatch: 'The password and its confirmation do not match.',
  missing_fields: 'Enter a password and the six digit code from your authenticator.',
  weak_password: 'The password does not meet the requirements.',
  finish_refused:
    'Setup was not completed. Check the six digit code and try again. If it keeps failing, ask for a fresh setup token.',
  qr_unavailable:
    'The QR code could not be drawn. Enter the setup key below in your authenticator instead.',
};

export const PROBLEM_TEXT: Readonly<Record<PasswordProblem, string>> = {
  too_short: 'The password is too short.',
  too_long: 'The password is too long.',
  equals_email: 'The password must not be the same as the account e-mail address.',
  not_well_formed: 'The password contains characters that are not allowed.',
};

const QR_SCALE = 6;
const QR_QUIET_ZONE = 4;

function drawQr(canvas: HTMLCanvasElement, matrix: QrMatrix): void {
  const modules = matrix.size + QR_QUIET_ZONE * 2;
  canvas.width = modules * QR_SCALE;
  canvas.height = modules * QR_SCALE;
  const context = canvas.getContext('2d');
  if (context === null) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) {
        context.fillRect(
          (x + QR_QUIET_ZONE) * QR_SCALE,
          (y + QR_QUIET_ZONE) * QR_SCALE,
          QR_SCALE,
          QR_SCALE,
        );
      }
    });
  });
}

type Child = Node | string;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  for (const child of children) node.append(child);
  return node;
}

const INPUT_CLASS =
  'mt-1 block w-full rounded border border-gray-400 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-600';
const BUTTON_CLASS =
  'rounded bg-blue-700 px-4 py-2 text-base font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 disabled:opacity-60';

function field(
  id: string,
  label: string,
  attributes: Readonly<Record<string, string>>,
  hint?: string,
): { wrapper: HTMLElement; input: HTMLInputElement } {
  const input = el('input', {
    id,
    name: id,
    class: INPUT_CLASS,
    autocapitalize: 'off',
    spellcheck: 'false',
    required: '',
    ...(hint === undefined ? {} : { 'aria-describedby': `${id}-hint` }),
    ...attributes,
  });
  const wrapper = el(
    'div',
    { class: 'mt-4' },
    el('label', { for: id, class: 'block text-sm font-medium' }, label),
    ...(hint === undefined
      ? []
      : [el('p', { id: `${id}-hint`, class: 'mt-1 text-sm text-gray-700' }, hint)]),
    input,
  );
  return { wrapper, input };
}

export interface SetupMountDeps {
  readonly transport: SetupTransport;
  readonly navigate: (path: string) => void;
}

export function mountSetup(root: HTMLElement, deps: SetupMountDeps): () => void {
  const controller = createSetupController({ transport: deps.transport });
  let rendered: SetupStage | null = null;
  let inputs: Record<string, HTMLInputElement> = {};
  let status: HTMLElement | null = null;
  let notice: HTMLElement | null = null;
  let submit: HTMLButtonElement | null = null;

  const heading = (text: string): HTMLElement => {
    const node = el(
      'h1',
      { class: 'text-2xl font-semibold', tabindex: '-1', id: 'setup-heading' },
      text,
    );
    return node;
  };

  const wipeInputs = (): void => {
    for (const input of Object.values(inputs)) input.value = '';
    inputs = {};
  };

  const buildToken = (): HTMLElement => {
    const token = field('setup-token', 'Setup token', {
      type: 'password',
      autocomplete: 'off',
      'aria-describedby': 'setup-token-hint',
    });
    const hint = el(
      'p',
      { id: 'setup-token-hint', class: 'mt-1 text-sm text-gray-700' },
      'Paste the one-time token printed by the command that created your administrator account. It is never put in the address bar.',
    );
    token.wrapper.insertBefore(hint, token.input);
    inputs = { token: token.input };
    submit = el('button', { type: 'submit', class: BUTTON_CLASS }, 'Continue');
    const form = el(
      'form',
      { id: 'token-form', novalidate: '', 'aria-labelledby': 'setup-heading' },
      token.wrapper,
      el('div', { class: 'mt-6' }, submit),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void controller.submitToken(token.input.value);
    });
    return el(
      'section',
      {},
      heading('Set up the administrator account'),
      el(
        'p',
        { class: 'mt-2 text-gray-700' },
        'Step 1 of 2. Enter your setup token. You will then choose a password and connect an authenticator app.',
      ),
      form,
    );
  };

  const buildEnroll = (snapshot: SetupSnapshot): HTMLElement => {
    const enrollment = snapshot.enrollment;
    const password = field('setup-password', 'Password', {
      type: 'password',
      autocomplete: 'new-password',
    });
    const confirmation = field('setup-password-confirm', 'Confirm password', {
      type: 'password',
      autocomplete: 'new-password',
    });
    const code = field('setup-code', 'Six digit code from your authenticator', {
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      pattern: '[0-9 ]*',
    });
    inputs = { password: password.input, confirmation: confirmation.input, code: code.input };

    const qrBlock = el('div', { class: 'mt-4' });
    if (enrollment?.qr) {
      const canvas = el('canvas', {
        id: 'setup-qr',
        role: 'img',
        'aria-label':
          'QR code for your authenticator app. If you cannot scan it, use the setup key below.',
        class: 'h-auto max-w-full rounded border border-gray-400 [image-rendering:pixelated]',
      });
      drawQr(canvas, enrollment.qr);
      qrBlock.append(canvas);
    }
    const secretBlock = el(
      'div',
      { class: 'mt-4' },
      el(
        'p',
        { class: 'text-sm font-medium', id: 'setup-secret-label' },
        'Setup key (enter manually)',
      ),
      el(
        'code',
        {
          id: 'setup-secret',
          'aria-labelledby': 'setup-secret-label',
          class: 'mt-1 block break-all rounded bg-gray-100 px-3 py-2 font-mono text-base',
        },
        enrollment?.secret ?? '',
      ),
      el(
        'p',
        { class: 'mt-1 text-sm text-gray-700' },
        'Type: time based, 6 digits, 30 seconds, SHA-1.',
      ),
    );
    submit = el('button', { type: 'submit', class: BUTTON_CLASS }, 'Finish setup');
    const form = el(
      'form',
      { id: 'finish-form', novalidate: '', 'aria-labelledby': 'setup-heading' },
      password.wrapper,
      confirmation.wrapper,
      code.wrapper,
      el('div', { class: 'mt-6' }, submit),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void controller.finish({
        password: password.input.value,
        confirmation: confirmation.input.value,
        code: code.input.value,
      });
    });
    return el(
      'section',
      {},
      heading('Connect your authenticator'),
      el(
        'p',
        { class: 'mt-2 text-gray-700' },
        'Step 2 of 2. Scan the QR code with an authenticator app, or enter the setup key by hand. Then choose a password and enter the current code.',
      ),
      qrBlock,
      secretBlock,
      form,
    );
  };

  const buildDone = (): HTMLElement => {
    const open = el(
      'button',
      { type: 'button', id: 'open-app', class: BUTTON_CLASS },
      'Open Package Broker',
    );
    open.addEventListener('click', () => {
      deps.navigate(APP_PATH);
    });
    return el(
      'section',
      {},
      heading('Setup complete'),
      el(
        'p',
        { class: 'mt-2 text-gray-700' },
        'Your administrator account is ready and you are signed in. From now on sign in with your e-mail address, your password and a code from your authenticator.',
      ),
      el('div', { class: 'mt-6' }, open),
    );
  };

  const buildUncertain = (): HTMLElement =>
    el(
      'section',
      {},
      heading('Setup may or may not have finished'),
      el(
        'p',
        { class: 'mt-2 text-gray-700' },
        'The broker did not give a clear answer. Nothing was retried. Keep your authenticator enrollment and the password you chose. The broker currently accepts sign-in through its HTTP API. If sign-in fails, ask for a fresh setup token and start again.',
      ),
      el(
        'p',
        { class: 'mt-4 text-gray-700' },
        'From a trusted HTTP client, send POST /_pb/auth/local/login to this broker with Content-Type: application/json and an Origin header equal to the broker address. Supply JSON fields email (your administrator e-mail address), password (the password you just chose), and code (a fresh six digit authenticator code). Read credentials from a protected file or private prompt, rather than command-line arguments. Save the response to a protected file and session cookies to a protected cookie jar; do not print either. A 204 response means you are signed in for subsequent requests using that cookie jar in the same client. See docs/workers-install.md for curl instructions and cleanup.',
      ),
    );

  const render = (): void => {
    const snapshot = controller.snapshot();
    if (rendered !== snapshot.stage) {
      wipeInputs();
      root.replaceChildren();
      const content =
        snapshot.stage === 'checking' ||
        snapshot.stage === 'disabled' ||
        snapshot.stage === 'unavailable'
          ? el(
              'section',
              {},
              heading(
                snapshot.stage === 'disabled'
                  ? "Sign in with your organization's account"
                  : snapshot.stage === 'unavailable'
                    ? 'Setup is unavailable'
                    : 'Set up the administrator account',
              ),
              el(
                'p',
                {
                  role: snapshot.stage === 'unavailable' ? 'alert' : 'status',
                  class: 'mt-2 text-gray-700',
                },
                snapshot.stage === 'checking'
                  ? 'Checking sign-in options…'
                  : snapshot.stage === 'disabled'
                    ? 'Password setup is unavailable. Sign in to continue, or contact your administrator for help.'
                    : 'Sign-in options could not be loaded. Reload the page to try again.',
              ),
              el(
                'a',
                { href: `${APP_PATH}#/login`, class: 'mt-4 block text-blue-700 underline' },
                'Go to sign in',
              ),
            )
          : snapshot.stage === 'token'
            ? buildToken()
            : snapshot.stage === 'enroll'
              ? buildEnroll(snapshot)
              : snapshot.stage === 'done'
                ? buildDone()
                : buildUncertain();
      notice = el('div', { id: 'setup-notice', role: 'alert', class: 'mt-4 text-red-800' });
      status = el('p', { id: 'setup-status', role: 'status', class: 'mt-4 text-gray-700' });
      root.append(content, notice, status);
      document.getElementById('setup-heading')?.focus();
      rendered = snapshot.stage;
    }
    if (submit) submit.disabled = snapshot.busy;
    if (status) status.textContent = snapshot.busy ? 'Working…' : '';
    if (notice) {
      notice.replaceChildren();
      if (snapshot.notice !== null) {
        notice.append(el('p', {}, NOTICE_TEXT[snapshot.notice]));
        if (snapshot.notice === 'weak_password') {
          notice.append(
            el(
              'ul',
              { class: 'mt-1 list-disc pl-6' },
              ...snapshot.problems.map((problem) => el('li', {}, PROBLEM_TEXT[problem])),
            ),
          );
        }
      }
    }
  };

  const unsubscribe = controller.subscribe(render);
  render();
  return () => {
    unsubscribe();
    wipeInputs();
    controller.dispose();
    root.replaceChildren();
  };
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('root');
  if (root !== null) {
    const dispose = mountSetup(root, {
      transport: createFetchTransport(fetch.bind(globalThis)),
      navigate: (path) => {
        window.location.assign(path);
      },
    });
    window.addEventListener('pagehide', dispose, { once: true });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) window.location.reload();
    });
  }
}
