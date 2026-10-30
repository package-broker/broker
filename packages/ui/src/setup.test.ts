import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_PATH,
  NOTICE_TEXT,
  PROBLEM_TEXT,
  SETUP_FINISH_PATH,
  SETUP_START_PATH,
  createFetchTransport,
  createSetupController,
  mountSetup,
  type SetupResponse,
  type SetupTransport,
} from './setup.js';

const TOKEN = 'T'.repeat(43);
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Package%20Broker:admin%40example.test?secret=${SECRET}&issuer=Package%20Broker&algorithm=SHA1&digits=6&period=30`;
const PASSWORD = 'correct horse battery staple';
const STARTED: SetupResponse = {
  status: 200,
  json: { provisioningUri: URI, secret: SECRET },
};

class TestElement {
  readonly children: (TestElement | string)[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, () => void> = {};
  value = '';
  textContent = '';
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  append(...children: (TestElement | string)[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: (TestElement | string)[]) {
    this.children.splice(0);
    this.append(...children);
  }
  insertBefore(child: TestElement, target: TestElement) {
    this.children.splice(this.children.indexOf(target), 0, child);
  }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners[name] = () => listener({ preventDefault() {} });
  }
  focus() {}
  all(): TestElement[] {
    return [
      this,
      ...this.children.flatMap((child) => (typeof child === 'string' ? [] : child.all())),
    ];
  }
  text(): string {
    return (
      this.textContent +
      this.children.map((child) => (typeof child === 'string' ? child : child.text())).join(' ')
    );
  }
}

describe('uncertain finish recovery', () => {
  it('renders actionable local-login instructions without linking to an authenticated sign-in page', async () => {
    const root = new TestElement('main');
    const byId = (id: string) => root.all().find((node) => node.attributes['id'] === id)!;
    vi.stubGlobal('document', {
      createElement: (tag: string) => new TestElement(tag),
      getElementById: byId,
    });
    const { transport, post } = transportOf(
      { status: 200, json: { provisioningUri: 'x'.repeat(400), secret: SECRET } },
      new Error('connection lost'),
    );
    const navigate = vi.fn();
    const dispose = mountSetup(root as unknown as HTMLElement, { transport, navigate });
    try {
      await vi.waitFor(() => expect(byId('setup-token')).toBeDefined());
      byId('setup-token').value = TOKEN;
      byId('token-form').listeners['submit']!();
      await vi.waitFor(() => expect(byId('finish-form')).toBeDefined());
      byId('setup-password').value = PASSWORD;
      byId('setup-password-confirm').value = PASSWORD;
      byId('setup-code').value = '123456';
      byId('finish-form').listeners['submit']!();
      await vi.waitFor(() => expect(root.text()).toContain('Setup may or may not have finished'));
      const text = root.text();
      for (const instruction of [
        'POST /_pb/auth/local/login',
        'Origin',
        'application/json',
        'email',
        'password',
        'code',
        'cookie',
        'fresh setup token',
      ]) {
        expect(text).toContain(instruction);
      }
      expect(
        root.all().some((node) => node.tag === 'a' && node.attributes['href'] === APP_PATH),
      ).toBe(false);
      expect(post).toHaveBeenCalledTimes(2);
      expect(navigate).not.toHaveBeenCalled();
      for (const secret of [TOKEN, SECRET, PASSWORD]) expect(text.includes(secret)).toBe(false);
    } finally {
      dispose();
      vi.unstubAllGlobals();
    }
  });
});

describe('curl setup credential handling', () => {
  it('protects response bodies and session cookies, restricts files and cleans them up', () => {
    const guide = readFileSync(
      new URL('../../../docs/workers-install.md', import.meta.url),
      'utf8',
    );
    const calls = [
      ...guide.matchAll(/curl [\s\S]*?"\$BROKER\/_pb\/auth\/local\/setup\/(?:start|finish)"/g),
    ].map(([call]) => call);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatch(/--output\s+"\$[^"]+"/);
      expect(call).not.toMatch(/--include|--verbose|--trace|--dump-header/);
    }
    expect(calls[1]).toMatch(/--cookie-jar\s+"\$[^"]+"/);
    expect(guide).toContain('umask 077');
    expect(guide).toContain('set +x');
    expect(guide).toMatch(/trap\s+'rm -rf/);
    expect(guide).toContain('mktemp -d');
  });
});

function transportOf(...responses: (SetupResponse | Error)[]) {
  const get = vi
    .fn<SetupTransport['get']>()
    .mockResolvedValue({ status: 200, json: { local: true } });
  const post = vi.fn<SetupTransport['post']>();
  for (const response of responses) {
    if (response instanceof Error) post.mockRejectedValueOnce(response);
    else post.mockResolvedValueOnce(response);
  }
  return { transport: { get, post } satisfies SetupTransport, get, post };
}

async function enrolled(...rest: (SetupResponse | Error)[]) {
  const harness = transportOf(STARTED, ...rest);
  const controller = createSetupController({ transport: harness.transport });
  await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
  await controller.submitToken(TOKEN);
  return { ...harness, controller };
}

describe('setup request mapping', () => {
  it('posts only the token to the existing start endpoint', async () => {
    const { controller, post } = await enrolled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(SETUP_START_PATH, { token: TOKEN });
    expect(SETUP_START_PATH).toBe('/_pb/auth/local/setup/start');
    expect(controller.snapshot().stage).toBe('enroll');
    expect(controller.snapshot().enrollment?.secret).toBe(SECRET);
    expect(controller.snapshot().enrollment?.provisioningUri).toBe(URI);
    expect(controller.snapshot().enrollment?.qr).not.toBeNull();
  });

  it('posts token, password and code to the existing finish endpoint and strips code spaces', async () => {
    const { controller, post } = await enrolled({ status: 204, json: null });
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123 456' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(SETUP_FINISH_PATH, {
      token: TOKEN,
      password: PASSWORD,
      code: '123456',
    });
    expect(SETUP_FINISH_PATH).toBe('/_pb/auth/local/setup/finish');
    expect(controller.snapshot().stage).toBe('done');
  });

  it('posts only to the two existing setup endpoints', async () => {
    const { controller, post } = await enrolled(
      { status: 400, json: null },
      { status: 204, json: null },
    );
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '000000' });
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '000000' });
    const paths = new Set(post.mock.calls.map(([path]) => path));
    expect([...paths].sort()).toEqual([SETUP_FINISH_PATH, SETUP_START_PATH].sort());
  });

  it('rejects a malformed token without a setup POST', async () => {
    const { transport, post } = transportOf();
    const controller = createSetupController({ transport });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
    await controller.submitToken('short');
    await controller.submitToken(`${'a'.repeat(42)}!`);
    expect(post).not.toHaveBeenCalled();
    expect(controller.snapshot().notice).toBe('bad_token_shape');
  });

  it('does not send when the confirmation differs or fields are empty', async () => {
    const { controller, post } = await enrolled();
    await controller.finish({ password: PASSWORD, confirmation: `${PASSWORD}x`, code: '123456' });
    expect(controller.snapshot().notice).toBe('password_mismatch');
    await controller.finish({ password: '', confirmation: '', code: '123456' });
    expect(controller.snapshot().notice).toBe('missing_fields');
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '  ' });
    expect(controller.snapshot().notice).toBe('missing_fields');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('setup responses', () => {
  it.each([
    [401, 'token_refused'],
    [400, 'token_refused'],
    [403, 'origin_refused'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
  ] as const)('maps start status %i to %s and stays on the token step', async (status, notice) => {
    const { transport } = transportOf({ status, json: null });
    const controller = createSetupController({ transport });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
    await controller.submitToken(TOKEN);
    expect(controller.snapshot()).toMatchObject({ stage: 'token', notice, busy: false });
    expect(controller.snapshot().enrollment).toBeNull();
  });

  it('shows the same generic text for every refused token', () => {
    expect(NOTICE_TEXT.token_refused).toMatch(/wrong, expired or already used/);
    expect(NOTICE_TEXT.token_refused).toMatch(/fresh token/);
    expect(NOTICE_TEXT.token_refused).not.toMatch(/@|e-mail/);
  });

  it('treats a network failure on start as unavailable', async () => {
    const { transport } = transportOf(new Error('offline'));
    const controller = createSetupController({ transport });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
    await controller.submitToken(TOKEN);
    expect(controller.snapshot().notice).toBe('unavailable');
  });

  it('treats a start response without the expected fields as unavailable', async () => {
    const { transport } = transportOf({ status: 200, json: { secret: SECRET } });
    const controller = createSetupController({ transport });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
    await controller.submitToken(TOKEN);
    expect(controller.snapshot()).toMatchObject({ stage: 'token', notice: 'unavailable' });
  });

  it('keeps the manual secret when the QR cannot be drawn', async () => {
    const long = `otpauth://totp/${'a'.repeat(400)}?secret=${SECRET}`;
    const { transport } = transportOf({
      status: 200,
      json: { provisioningUri: long, secret: SECRET },
    });
    const controller = createSetupController({ transport });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
    await controller.submitToken(TOKEN);
    expect(controller.snapshot()).toMatchObject({ stage: 'enroll', notice: 'qr_unavailable' });
    expect(controller.snapshot().enrollment?.qr).toBeNull();
    expect(controller.snapshot().enrollment?.secret).toBe(SECRET);
  });

  it('maps password problems from the existing weak_password response', async () => {
    const { controller } = await enrolled({
      status: 400,
      json: {
        error: {
          code: 'weak_password',
          message: 'm',
          requestId: 'r',
          problems: ['too_short', 'bogus', 'equals_email'],
        },
      },
    });
    await controller.finish({ password: 'short', confirmation: 'short', code: '123456' });
    expect(controller.snapshot()).toMatchObject({
      stage: 'enroll',
      notice: 'weak_password',
      problems: ['too_short', 'equals_email'],
    });
    for (const text of Object.values(PROBLEM_TEXT)) expect(text).not.toMatch(/@/);
  });

  it('stays on the enrollment step for a refused finish so the operator can retry by hand', async () => {
    const { controller, post } = await enrolled({ status: 401, json: null });
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
    expect(controller.snapshot()).toMatchObject({ stage: 'enroll', notice: 'finish_refused' });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a network failure', new Error('reset')],
    ['a server error', { status: 502, json: null } satisfies SetupResponse],
  ])('does not retry after %s and ends in the uncertain state', async (_, outcome) => {
    const { controller, post } = await enrolled(outcome);
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
    expect(controller.snapshot()).toMatchObject({ stage: 'uncertain', enrollment: null });
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
    await controller.submitToken(TOKEN);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('ignores a second submit while a request is in flight', async () => {
    let release: (response: SetupResponse) => void = () => undefined;
    const post = vi
      .fn<SetupTransport['post']>()
      .mockResolvedValueOnce(STARTED)
      .mockImplementationOnce(
        () =>
          new Promise<SetupResponse>((resolve) => {
            release = resolve;
          }),
      );
    const controller = createSetupController({ transport: { post, get: transportOf().get } });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
    await controller.submitToken(TOKEN);
    const first = controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
    expect(post).toHaveBeenCalledTimes(2);
    release({ status: 204, json: null });
    await first;
    expect(controller.snapshot().stage).toBe('done');
  });

  it('notifies subscribers and stops after dispose', async () => {
    const { transport } = transportOf(STARTED);
    const controller = createSetupController({ transport });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.submitToken(TOKEN);
    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls.length;
    unsubscribe();
    controller.dispose();
    expect(controller.snapshot().enrollment).toBeNull();
    expect(listener.mock.calls.length).toBe(calls);
  });
});

describe('setup keeps secrets in memory only', () => {
  const stores = ['localStorage', 'sessionStorage', 'indexedDB'] as const;
  const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), put: vi.fn() };
  const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );

  beforeEach(() => {
    for (const name of stores) vi.stubGlobal(name, storage);
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('navigator', { clipboard: storage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    storage.setItem.mockClear();
    for (const spy of consoleSpies) spy.mockClear();
  });

  it('writes to no storage, cookie, clipboard or console across success and failure flows', async () => {
    const { controller } = await enrolled(
      { status: 401, json: null },
      { status: 400, json: { error: { code: 'weak_password', problems: ['too_short'] } } },
      { status: 204, json: null },
    );
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '111111' });
    await controller.finish({ password: 'x', confirmation: 'x', code: '222222' });
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '333333' });
    expect(controller.snapshot().stage).toBe('done');
    for (const spy of Object.values(storage)) expect(spy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    expect(globalThis.document.cookie).toBe('');
  });

  it('clears the token, secret and URI from the state on completion', async () => {
    const { controller } = await enrolled({ status: 204, json: null });
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
    const text = JSON.stringify(controller.snapshot());
    for (const secret of [TOKEN, SECRET, URI, PASSWORD, 'otpauth']) {
      expect(text).not.toContain(secret);
    }
  });

  it('never carries a secret in a path, query or fragment', async () => {
    const { controller, post } = await enrolled({ status: 204, json: null });
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
    for (const [path] of post.mock.calls) {
      expect(path).not.toMatch(/[?#]/);
      expect(path).not.toContain(TOKEN);
    }
    expect(APP_PATH).toBe('/_pb/ui/');
  });

  it('keeps the module free of storage, logging, history, clipboard and HTML injection', () => {
    const source = readFileSync(new URL('./setup.tsx', import.meta.url), 'utf8');
    for (const forbidden of [
      /localStorage/,
      /sessionStorage/,
      /indexedDB/,
      /document\.cookie/,
      /console\./,
      /history\./,
      /clipboard/,
      /location\.(?:search|hash|href\s*=)/,
      /innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/,
      /\beval\s*\(|new Function/,
      /https?:\/\//,
      /XMLHttpRequest|sendBeacon|WebSocket/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});

describe('fetch transport', () => {
  it('posts JSON same-origin without cache, redirects or referrer', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const transport = createFetchTransport(fetchImpl as unknown as typeof fetch);
    const response = await transport.post(SETUP_START_PATH, { token: TOKEN });
    expect(response).toEqual({ status: 200, json: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledWith(SETUP_START_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  });

  it('returns a null body for an empty or unreadable response', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = createFetchTransport(fetchImpl as unknown as typeof fetch);
    expect(await transport.post(SETUP_FINISH_PATH, { token: TOKEN })).toEqual({
      status: 204,
      json: null,
    });
  });
});

describe('setup availability', () => {
  it('ignores tokens and finishes while checking, then keeps disabled setup closed', async () => {
    let resolve!: (response: SetupResponse) => void;
    const get = vi.fn<SetupTransport['get']>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const post = vi.fn<SetupTransport['post']>();
    const controller = createSetupController({ transport: { get, post } });
    expect(controller.snapshot().stage).toBe('checking');
    await controller.submitToken(TOKEN);
    await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
    expect(post).not.toHaveBeenCalled();
    resolve({ status: 200, json: { local: false } });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('disabled'));
    await controller.submitToken(TOKEN);
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledExactlyOnceWith('/_pb/auth/providers');
    expect(JSON.stringify(controller.snapshot())).not.toContain(TOKEN);
  });

  it.each([
    { status: 503, json: { local: true } },
    { status: 200, json: {} },
    { status: 200, json: { local: 'true' } },
    new Error('private-request-data'),
  ])('fails closed when availability cannot be confirmed', async (response) => {
    const get = vi.fn<SetupTransport['get']>();
    if (response instanceof Error) get.mockRejectedValue(response);
    else get.mockResolvedValue(response);
    const post = vi.fn<SetupTransport['post']>();
    const controller = createSetupController({ transport: { get, post } });
    await vi.waitFor(() => expect(controller.snapshot().stage).toBe('unavailable'));
    await controller.submitToken(TOKEN);
    expect(post).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.snapshot())).not.toContain('private-request-data');
  });

  it('ignores availability responses after disposal', async () => {
    let resolve!: (response: SetupResponse) => void;
    const controller = createSetupController({
      transport: {
        get: () =>
          new Promise((done) => {
            resolve = done;
          }),
        post: vi.fn(),
      },
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.dispose();
    const readJson = vi.fn(() => ({ local: true }));
    resolve({
      status: 200,
      get json() {
        return readJson();
      },
    });
    await Promise.resolve();
    expect(readJson).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(controller.snapshot().stage).toBe('checking');
  });
});

describe('standalone setup availability rendering', () => {
  it.each([
    [
      { status: 200, json: { local: false } },
      "Sign in with your organization's account",
      'Password setup is unavailable',
    ],
    [{ status: 503, json: null }, 'Setup is unavailable', 'Sign-in options could not be loaded'],
  ])('shows the availability heading and login link for %j', async (response, title, body) => {
    const root = new TestElement('main');
    vi.stubGlobal('document', {
      createElement: (tag: string) => new TestElement(tag),
      getElementById: (id: string) => root.all().find((node) => node.attributes['id'] === id),
    });
    const post = vi.fn<SetupTransport['post']>();
    const dispose = mountSetup(root as unknown as HTMLElement, {
      transport: { get: async () => response, post },
      navigate: vi.fn(),
    });
    try {
      expect(root.text()).toContain('Checking sign-in options');
      expect(root.all().filter((node) => node.tag === 'input')).toHaveLength(0);
      await vi.waitFor(() => expect(root.text()).toContain(body));
      expect(
        root
          .all()
          .find((node) => node.tag === 'h1')
          ?.text(),
      ).toBe('Set up the administrator account');
      expect(
        root
          .all()
          .find((node) => node.tag === 'h2')
          ?.text(),
      ).toBe(title);
      expect(root.all().filter((node) => node.tag === 'input')).toHaveLength(0);
      expect(root.all().find((node) => node.tag === 'a')?.attributes['href']).toBe(
        '/_pb/ui/#/login',
      );
      expect(post).not.toHaveBeenCalled();
    } finally {
      dispose();
      vi.unstubAllGlobals();
    }
  });

  it('fetches availability without credentials in URLs, bodies, referrers or cache', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ local: false, providers: [] }));
    const transport = createFetchTransport(fetchImpl as unknown as typeof fetch);
    expect(await transport.get('/_pb/auth/providers')).toEqual({
      status: 200,
      json: { local: false, providers: [] },
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('/_pb/auth/providers', {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  });
});

describe('setup policy changes while open', () => {
  it.each(['start', 'finish'] as const)(
    'disables setup on a %s policy refusal and clears secrets',
    async (step) => {
      const refused = { status: 403, json: { error: { code: 'local_auth_disabled' } } };
      const { transport, post } = transportOf(
        ...(step === 'finish' ? [STARTED, refused] : [refused]),
      );
      const controller = createSetupController({ transport });
      await vi.waitFor(() => expect(controller.snapshot().stage).toBe('token'));
      await controller.submitToken(TOKEN);
      if (step === 'finish')
        await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
      expect(controller.snapshot()).toMatchObject({
        stage: 'disabled',
        busy: false,
        notice: null,
        enrollment: null,
        problems: [],
      });
      const calls = post.mock.calls.length;
      await controller.submitToken(TOKEN);
      await controller.finish({ password: PASSWORD, confirmation: PASSWORD, code: '123456' });
      expect(post).toHaveBeenCalledTimes(calls);
      for (const secret of [TOKEN, PASSWORD, SECRET])
        expect(JSON.stringify(controller.snapshot())).not.toContain(secret);
    },
  );
});

it('does not report a listener exception as unavailable setup', async () => {
  const availability = Promise.resolve({ status: 200, json: { local: true } });
  const then = vi.spyOn(availability, 'then');
  const controller = createSetupController({
    transport: { get: () => availability, post: vi.fn() },
  });
  const error = new Error('render failed');
  const listener = vi.fn(() => {
    throw error;
  });
  controller.subscribe(listener);
  await expect(then.mock.results[0]!.value).rejects.toBe(error);
  expect(controller.snapshot().stage).toBe('token');
  expect(listener).toHaveBeenCalledTimes(1);
  controller.dispose();
});
