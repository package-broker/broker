import { randomBytes } from 'node:crypto';
import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  fixture,
  guardContext,
  fillSecret,
  readSecret,
  go,
  openDetails,
  assertSecretAbsent,
  assertLayout,
  fixtureDatabase,
  seedLists,
  authCode,
  base32Decode,
} from './fixture.js';

test.describe.serial('Node management UI', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let verify: () => Promise<void>;
  let enrollment: Uint8Array;
  const password = `Browser-${randomBytes(24).toString('base64url')}!42`;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    browser = await chromium.launch();
    context = await browser.newContext({ serviceWorkers: 'block' });
    verify = await guardContext(context);
    page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    seedLists();
  });

  test.afterEach(async () => {
    if (verify) await verify();
  });
  test.afterAll(async () => {
    await browser?.close();
  });

  test('setup enrolls an admin and local login reaches projects', async () => {
    await page.goto(`${fixture.origin}/_pb/ui/setup`);
    await fillSecret(page.getByLabel('Setup token'), fixture.token);
    const started = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/_pb/auth/local/setup/start',
    );
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const response = await started;
    expect(response.status()).toBe(200);
    enrollment = base32Decode(await readSecret(response, 'secret'));
    await expect(page.locator('#setup-qr')).toBeVisible();
    await fillSecret(page.getByLabel('Password', { exact: true }), password);
    await fillSecret(page.getByLabel('Confirm password', { exact: true }), password);
    await fillSecret(
      page.getByLabel('Six digit code from your authenticator'),
      await authCode(enrollment, -1),
    );
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page.getByRole('heading', { name: 'Setup complete', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open Package Broker', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await openDetails(page, 'Account');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await fillSecret(page.getByLabel('E-mail', { exact: true }), fixture.email);
    await fillSecret(page.getByLabel('Password', { exact: true }), password);
    await fillSecret(page.getByLabel('Authenticator code'), await authCode(enrollment));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await assertSecretAbsent(page, password);
  });

  test('creates a project and switches project and organization scope', async () => {
    await go(page, 'projects');
    await openDetails(page, 'New project');
    await page.getByLabel('Project name', { exact: true }).fill('Browser archive target');
    await page.getByLabel('Slug', { exact: true }).fill('browser-archive');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Browser archive target', exact: true }),
    ).toBeVisible();
    await page.reload();
    await page
      .getByRole('combobox', { name: 'Scope', exact: true })
      .selectOption('browser-fixture');
    await expect(page).toHaveURL(/project=browser-fixture/);
    await page
      .getByRole('combobox', { name: 'Scope', exact: true })
      .selectOption('__organization__');
    expect(new URL(page.url()).hash.includes('project=')).toBe(false);
  });

  test('destructive confirm names its target and reauth waits for confirm before replay', async () => {
    await go(page, 'projects', 'project=browser-archive');
    const settings = page.getByRole('region', { name: 'Project settings' });
    await expect(settings.getByRole('button', { name: 'Archive', exact: true })).toBeEnabled();
    fixtureDatabase((db, org) => {
      const changed = db
        .prepare('UPDATE session SET reauth_at = NULL WHERE org_id = ? AND revoked_at IS NULL')
        .run(org);
      expect(Number(changed.changes)).toBeGreaterThan(0);
    });
    await settings.getByRole('button', { name: 'Archive', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive?', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Browser archive target');
    await dialog.getByRole('button', { name: 'Confirm archive', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
    expect(projectStatus()).toBe('active');
    await fillSecret(page.getByLabel('Password', { exact: true }), password);
    await fillSecret(page.getByLabel('Authenticator code'), await authCode(enrollment, 1));
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    const replay = page.getByRole('dialog', { name: 'Send the held action now?', exact: true });
    await expect(replay).toBeVisible();
    expect(projectStatus()).toBe('active');
    await replay.getByRole('button', { name: 'Send held action', exact: true }).click();
    await expect.poll(projectStatus).toBe('archived');
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  });

  function projectStatus() {
    return fixtureDatabase(
      (db, org) =>
        db
          .prepare('SELECT status FROM project WHERE org_id = ? AND slug = ?')
          .get(org, 'browser-archive')?.status,
    );
  }

  let tokenSecret: string;
  test('issues a token and displays the returned secret once', async () => {
    await go(page, 'tokens');
    await page.getByRole('combobox', { name: 'Token list', exact: true }).selectOption('personal');
    await openDetails(page, 'Issue token');
    await page.getByLabel('Name', { exact: true }).fill('Browser show once');
    const issued = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/_pb/me/tokens',
    );
    await page.getByRole('button', { name: 'Issue token', exact: true }).click();
    const response = await issued;
    expect(response.status()).toBe(201);
    tokenSecret = await readSecret(response, 'token');
    expect(
      typeof tokenSecret === 'string' && tokenSecret.length > 20,
      'response contains a secret',
    ).toBe(true);
    const displayed = page.getByRole('region', { name: 'Token secret', exact: true });
    await expect(displayed).toBeVisible();
    expect(
      (await displayed.locator('code').textContent()) === tokenSecret,
      'UI shows the issued secret',
    ).toBe(true);
  });

  test('navigation removes the token secret from the DOM', async () => {
    expect(typeof tokenSecret === 'string', 'issue scenario completed').toBe(true);
    await go(page, 'projects');
    await go(page, 'tokens');
    await expect(page.getByRole('region', { name: 'Token secret', exact: true })).toHaveCount(0);
    expect((await page.content()).includes(tokenSecret), 'secret absent from page.content()').toBe(
      false,
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();
    expect((await page.content()).includes(tokenSecret), 'secret absent from page.content()').toBe(
      false,
    );
  });

  for (const area of ['sessionStorage', 'localStorage'] as const) {
    test(`navigation leaves no token secret in ${area}`, async () => {
      expect(typeof tokenSecret === 'string', 'issue scenario completed').toBe(true);
      const absent = await page.evaluate(
        ({ area, secret }) => {
          const storage = window[area];
          return Array.from({ length: storage.length }, (_, i) => {
            const key = storage.key(i) ?? '';
            return `${key}\n${storage.getItem(key) ?? ''}`;
          }).every((value) => !value.includes(secret));
        },
        { area, secret: tokenSecret },
      );
      expect(absent, 'storage contains no token secret').toBe(true);
    });
  }

  test('source credential is write-only in DOM and storage after saving', async () => {
    await go(page, 'sources');
    await openDetails(page, 'Edit source');
    await page.getByRole('button', { name: 'Set credential', exact: true }).click();
    const material = randomBytes(32).toString('base64url');
    await page
      .getByRole('combobox', { name: 'Credential kind', exact: true })
      .selectOption('bearer');
    await fillSecret(page.getByLabel('token', { exact: true }), material);
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/credential'),
    );
    await page.getByRole('button', { name: 'Save credential', exact: true }).click();
    expect((await saved).status()).toBe(204);
    await expect(page.getByRole('status').filter({ hasText: 'credential set' })).toBeVisible();
    await assertSecretAbsent(page, material);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
    await expect(page.getByText('Browser fixture source', { exact: true }).first()).toBeVisible();
    await openDetails(page, 'Edit source');
    await expect(page.getByRole('button', { name: 'Set credential', exact: true })).toBeVisible();
    await assertSecretAbsent(page, material);
  });

  for (const transport of ['no-cors fetch', 'HTML form'] as const) {
    test(`refuses a cross-origin POST from ${transport} with no auth state change`, async () => {
      const attack = await context.newPage();
      try {
        await attack.goto(fixture.otherOrigin);
        const before = authState();
        const reply = attack.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            new URL(r.url()).pathname === '/_pb/auth/local/login',
        );
        await attack.evaluate(
          ({ origin, transport }) => {
            const target = `${origin}/_pb/auth/local/login`;
            if (transport === 'no-cors fetch') {
              void fetch(target, {
                method: 'POST',
                mode: 'no-cors',
                credentials: 'include',
                body: '{}',
              });
            } else {
              const form = document.createElement('form');
              form.method = 'POST';
              form.action = target;
              form.enctype = 'text/plain';
              const input = document.createElement('input');
              input.name = '{"padding":"';
              input.value = '"}';
              form.append(input);
              document.body.append(form);
              form.submit();
            }
          },
          { origin: fixture.origin, transport },
        );
        const response = await reply;
        expect(response.status()).toBe(403);
        expect(response.request().headers()['origin']).toBe(fixture.otherOrigin);
        expect(authState()).toEqual(before);
      } finally {
        await attack.close();
      }
    });
  }

  function authState() {
    return fixtureDatabase((db, org) => ({
      sessions: db
        .prepare('SELECT id, revoked_at, reauth_at FROM session WHERE org_id = ? ORDER BY id')
        .all(org),
      logins: db
        .prepare(
          'SELECT user_id, credential_rev, totp_last_step, setup_hash FROM local_login WHERE org_id = ? ORDER BY user_id',
        )
        .all(org),
    }));
  }

  for (const width of [1440, 390]) {
    for (const route of [
      'projects',
      'access',
      'sources',
      'packages',
      'tokens',
      'audit',
      'import',
    ]) {
      test(`${route} list at ${width}px confines overflow to table containers`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await go(page, route);
        const table = page.locator('table').filter({ has: page.locator('tbody tr') });
        await expect(table.first()).toBeVisible();
        const marker = {
          projects: 'Browser fixture with a long project name for narrow screens',
          access: 'Organization Admin',
          sources: 'Browser fixture source',
          packages: '@browser-fixture/a-long-package-name-for-horizontal-overflow',
          tokens: 'Browser show once',
          audit: 'project.create',
          import: 'Planned',
        }[route]!;
        await expect(
          page.locator('tbody').getByText(marker, { exact: true }).first(),
        ).toBeVisible();
        await assertLayout(page);
      });
    }
  }

  for (const width of [1440, 390]) {
    test(`access roles list at ${width}px confines overflow to its container`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await go(page, 'access', 'status=roles');
      await expect(
        page.locator('tbody').getByText('Organization Admin', { exact: true }).first(),
      ).toBeVisible();
      await assertLayout(page);
    });
  }

  for (const route of ['projects', 'access', 'sources', 'packages', 'tokens', 'audit']) {
    test(`${route} mobile filters expand and collapse`, async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await go(page, route);
      const toolbar = page.locator('details.filter-toolbar');
      const toggle = toolbar.locator('summary');
      await expect(toggle).toBeVisible();
      await expect(toolbar).not.toHaveAttribute('open');
      await toggle.click();
      await expect(toolbar).toHaveAttribute('open');
      await expect(toolbar.locator('input').first()).toBeVisible();
      await toggle.click();
      await expect(toolbar).not.toHaveAttribute('open');
      await expect(toolbar.locator('input').first()).not.toBeVisible();
    });
  }

  for (const kind of ['link', 'redirect', 'subresource'] as const) {
    test(`external fixture ${kind} is aborted and the network guard reports failure`, async () => {
      const isolated = await browser.newContext({ serviceWorkers: 'block' });
      const check = await guardContext(isolated);
      try {
        const external = await isolated.newPage();
        await external.goto(fixture.otherOrigin);
        const blocked = external.waitForEvent('requestfailed');
        if (kind === 'redirect') {
          await external.goto(`${fixture.otherOrigin}/external-redirect`).catch(() => {});
        } else {
          await external.evaluate((transport) => {
            const node = document.createElement(transport === 'link' ? 'a' : 'img');
            if (node instanceof HTMLAnchorElement) {
              node.href = 'https://example.invalid';
              node.textContent = 'External fixture';
            } else node.src = 'https://example.invalid/pixel';
            document.body.append(node);
          }, kind);
          if (kind === 'link')
            await external
              .getByRole('link', { name: 'External fixture' })
              .click()
              .catch(() => {});
        }
        expect((await blocked).failure()?.errorText).toContain('ERR_BLOCKED_BY_CLIENT');
        await expect(check()).rejects.toThrow(
          kind === 'redirect'
            ? /redirect outside allowed origins/
            : /request outside allowed origins/,
        );
        expect(
          external.url().startsWith('https://example.invalid'),
          'external navigation was blocked',
        ).toBe(false);
      } finally {
        await isolated.close();
      }
    });
  }

  test('all visited UI pages have zero CSP violations and no injected style elements', async () => {
    await verify();
    expect(await page.locator('style').count()).toBe(0);
  });
});
