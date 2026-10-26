import { randomBytes } from 'node:crypto';
import { chromium, expect, test as base, type Browser, type Page } from '@playwright/test';
import {
  otherOrigin,
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
  activeDialog,
  packageTarget,
} from './fixture.js';
import { startNodeFixture, type Fixture } from '../dist/browser/fixtures.js';

let browser: Browser;
type Admin = { password: string; enrollment: Uint8Array };
const test = base.extend<{
  broker: Fixture;
  admin: Admin;
}>({
  broker: [
    // eslint-disable-next-line no-empty-pattern -- Playwright discovers dependencies from this pattern.
    async ({}, use) => {
      const broker = await startNodeFixture();
      try {
        seedLists(broker);
        await use(broker);
      } finally {
        await broker.stop();
      }
    },
    { timeout: 90_000 },
  ],
  context: async ({ broker }, use) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const verify = await guardContext(context, broker.origin);
    try {
      await use(context);
    } finally {
      try {
        await verify();
      } finally {
        await context.close();
      }
    }
  },
  admin: async ({ broker, context }, use) => {
    const password = `Browser-${randomBytes(24).toString('base64url')}!42`;
    const post = async (path: string, data: Record<string, string>) => {
      try {
        return await context.request.post(`${broker.origin}${path}`, {
          headers: { origin: broker.origin },
          data,
          maxRedirects: 0,
        });
      } catch {
        throw new Error('fixture enrollment request failed');
      }
    };
    const started = await post('/_pb/auth/local/setup/start', { token: broker.token });
    expect(started.status()).toBe(200);
    const enrollment = base32Decode(await readSecret(started, 'secret'));
    const finished = await post('/_pb/auth/local/setup/finish', {
      token: broker.token,
      password,
      code: await authCode(enrollment, -1),
    });
    expect(finished.status()).toBe(204);
    await use({ password, enrollment });
  },
  page: async ({ context, admin, broker }, use) => {
    void admin;
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${broker.origin}/_pb/ui/`);
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await use(page);
  },
});

test.describe('Node management UI', () => {
  async function tabTo(page: Page, target: ReturnType<Page['getByRole']>) {
    const visited = new Set<string>();
    const bound = await page
      .locator('button, a, input, select, textarea, summary, [tabindex]')
      .count();
    for (let step = 0; step <= bound + 1; step++) {
      if (await target.evaluate((element) => element === document.activeElement)) break;
      const active = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return String(elements.indexOf(document.activeElement!));
      });
      if (visited.has(active)) break;
      visited.add(active);
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
  }

  test('creates a source and restores its trigger using only the keyboard', async ({
    page,
    admin,
  }) => {
    await confirmIdentity(page, admin);
    await go(page, 'sources');
    const trigger = page.getByRole('button', { name: 'Add source', exact: true });
    await tabTo(page, trigger);
    await page.keyboard.press('Enter');
    const dialog = activeDialog(page, 'Add source');
    await expect(dialog.getByRole('radio', { name: 'Composer', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: 'npm', exact: true })).toBeChecked();
    await tabTo(page, dialog.getByLabel('Source name (required)', { exact: true }));
    await page.keyboard.type('Keyboard npm source');
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/_pb/sources',
    );
    await page.keyboard.press('Enter');
    expect((await created).status()).toBe(201);
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeEnabled();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('focuses Cancel and restores a confirmation trigger using only the keyboard', async ({
    page,
    admin,
  }) => {
    await confirmIdentity(page, admin);
    await go(page, 'projects');
    await createArchiveTarget(page);
    await go(page, 'projects', 'project=browser-archive');
    const trigger = page
      .getByRole('region', { name: 'Project settings' })
      .getByRole('button', { name: 'Archive', exact: true });
    await tabTo(page, trigger);
    await page.keyboard.press('Enter');
    const dialog = activeDialog(page, 'Archive?');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    browser = await chromium.launch();
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('setup enrolls an admin and local login reaches projects', async ({ context, broker }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    const password = `Browser-${randomBytes(24).toString('base64url')}!42`;
    await page.goto(`${broker.origin}/_pb/ui/setup`);
    await fillSecret(page.getByLabel('Setup token'), broker.token);
    const started = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/_pb/auth/local/setup/start',
    );
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const response = await started;
    expect(response.status()).toBe(200);
    const enrollment = base32Decode(await readSecret(response, 'secret'));
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
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await fillSecret(page.getByLabel('E-mail', { exact: true }), broker.email);
    await fillSecret(page.getByLabel('Password', { exact: true }), password);
    await fillSecret(page.getByLabel('Authenticator code'), await authCode(enrollment));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await assertSecretAbsent(page, password);
  });

  test('creates a project and switches project and organization scope', async ({ page }) => {
    await createArchiveTarget(page);
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

  test('package destructive confirm names its action, package and version before cancel', async ({
    page,
    broker,
  }) => {
    await go(page, 'packages', `package=${packageTarget.id}`);
    const versions = page.getByRole('region', {
      name: `Versions of ${packageTarget.name}`,
      exact: true,
    });
    await versions.getByRole('button', { name: 'Tombstone', exact: true }).click();
    const dialog = activeDialog(page, `Tombstone ${packageTarget.version}?`);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('dl dd')).toHaveText([
      packageTarget.name,
      packageTarget.version,
      'Organization',
    ]);
    await expect(
      dialog.getByRole('button', { name: 'Confirm tombstone', exact: true }),
    ).toBeVisible();
    expect(versionStatus(broker)).toBe('active');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(versionStatus(broker)).toBe('active');
  });

  test('archive confirm names its target and restore reauth waits for confirm before replay', async ({
    page,
    broker,
    admin,
  }) => {
    await createArchiveTarget(page);
    await go(page, 'projects', 'project=browser-archive');
    const settings = page.getByRole('region', { name: 'Project settings' });
    await expect(
      settings.getByRole('heading', { name: 'Settings: Browser archive target', exact: true }),
    ).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Archive', exact: true })).toBeEnabled();
    fixtureDatabase(broker, (db, org) => {
      const changed = db
        .prepare('UPDATE session SET reauth_at = NULL WHERE org_id = ? AND revoked_at IS NULL')
        .run(org);
      expect(Number(changed.changes)).toBeGreaterThan(0);
    });
    await settings.getByRole('button', { name: 'Archive', exact: true }).click();
    const dialog = activeDialog(page, 'Archive?');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('dl dd')).toHaveText([
      'Browser archive target',
      'Project: browser-archive',
    ]);
    const archivePath = '/_pb/projects/browser-archive/archive';
    expect(projectStatus(broker)).toBe('active');
    const archived = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === archivePath,
    );
    await dialog.getByRole('button', { name: 'Confirm archive', exact: true }).click();
    expect((await archived).status()).toBe(204);
    await expect.poll(() => projectStatus(broker)).toBe('archived');
    const archivedRow = page.getByRole('row').filter({
      has: page.getByRole('link', { name: 'Browser archive target', exact: true }),
    });
    await expect(
      archivedRow.getByRole('cell', { name: 'Status Archived', exact: true }),
    ).toBeVisible();
    await expect(archivedRow.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toContainText('Project archived.');
    await expect(page.getByRole('alert')).not.toContainText('Not found');
    await expect(settings).toHaveCount(0);
    await expect(page).toHaveURL(/#\/projects\?status=archived/);
    await page.reload();
    await expect(archivedRow.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
    const restorePath = '/_pb/projects/browser-archive/restore';
    const refused = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === restorePath,
    );
    await archivedRow.getByRole('button', { name: 'Restore', exact: true }).click();
    expect((await refused).status()).toBe(403);
    await expect(page).toHaveURL(/#\/reauth\?/);
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
    expect(projectStatus(broker)).toBe('archived');
    await submitReauth(page, admin);
    const replay = activeDialog(page, 'Send the held action now?');
    await expect(replay).toBeVisible();
    await expect(replay.locator('dl dt')).toHaveText(['Action', 'Project', 'Scope', 'Effect']);
    await expect(replay.locator('dl dd')).toHaveText([
      'Restore project',
      'browser-archive',
      'Project',
      'Restore this archived project.',
    ]);
    const details = replay.locator('details');
    await expect(details.locator('summary')).toHaveText('Request details');
    await expect(details).not.toHaveAttribute('open');
    await expect(details.locator('code')).not.toBeVisible();
    expect(projectStatus(broker)).toBe('archived');
    await details.locator('summary').click();
    await expect(details.locator('code')).toHaveText(`POST ${restorePath}`);
    await expect(details.getByRole('button', { name: 'Copy request', exact: true })).toBeVisible();
    expect(projectStatus(broker)).toBe('archived');
    const replayed = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === restorePath,
    );
    await replay.getByRole('button', { name: 'Restore project', exact: true }).click();
    expect((await replayed).status()).toBe(204);
    await expect.poll(() => projectStatus(broker)).toBe('active');
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  });

  async function createArchiveTarget(page: Page): Promise<void> {
    await go(page, 'projects');
    await openDetails(page, 'New project');
    await page.getByLabel('Project name', { exact: true }).fill('Browser archive target');
    await page.getByLabel('Slug', { exact: true }).fill('browser-archive');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Browser archive target', exact: true }),
    ).toBeVisible();
  }

  function projectStatus(broker: Fixture) {
    return fixtureDatabase(
      broker,
      (db, org) =>
        db
          .prepare('SELECT status FROM project WHERE org_id = ? AND slug = ?')
          .get(org, 'browser-archive')?.status,
    );
  }

  function versionStatus(broker: Fixture) {
    return fixtureDatabase(
      broker,
      (db, org) =>
        db
          .prepare('SELECT status FROM version WHERE org_id = ? AND id = ?')
          .get(org, packageTarget.versionId)?.status,
    );
  }

  async function submitReauth(page: Page, admin: Admin): Promise<void> {
    await fillSecret(page.getByLabel('Password', { exact: true }), admin.password);
    await fillSecret(page.getByLabel('Authenticator code'), await authCode(admin.enrollment));
    const reauthenticated = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && new URL(r.url()).pathname === '/_pb/auth/local/reauth',
    );
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    expect((await reauthenticated).status()).toBe(204);
  }

  async function confirmIdentity(page: Page, admin: Admin): Promise<void> {
    await page.evaluate(() => {
      window.location.hash = '#/reauth?return=%2Fprojects';
    });
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
    await submitReauth(page, admin);
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  }

  async function issueToken(page: Page, admin: Admin): Promise<string> {
    await confirmIdentity(page, admin);
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
    const tokenSecret = await readSecret(response, 'token');
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
    return tokenSecret;
  }

  test('issues a token and displays the returned secret once', async ({ page, admin }) => {
    await issueToken(page, admin);
  });

  test('navigation removes the token secret from the DOM', async ({ page, admin }) => {
    const tokenSecret = await issueToken(page, admin);
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
    test(`navigation leaves no token secret in ${area}`, async ({ page, admin }) => {
      const tokenSecret = await issueToken(page, admin);
      await go(page, 'projects');
      await go(page, 'tokens');
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

  test('source credential is write-only in DOM and storage after saving', async ({
    page,
    admin,
  }) => {
    await confirmIdentity(page, admin);
    await go(page, 'sources');
    await openDetails(page, 'More');
    await expect(page.getByText('Last listing:', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Last listing error:', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Next poll:', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeDisabled();
    await expect(page.getByText('Enable before syncing.', { exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Registered names', exact: true }).click();
    await page.getByLabel('Registered pattern', { exact: true }).fill('@browser-fixture/*');
    const registered = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/names'),
    );
    await page.getByRole('button', { name: 'Add name', exact: true }).click();
    expect((await registered).status()).toBe(201);
    await expect(activeDialog(page, 'Registered names')).toBeVisible();
    await activeDialog(page, 'Registered names')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await openDetails(page, 'More');
    await expect(page.getByRole('menuitem', { name: 'Enable', exact: true })).toBeEnabled();
    const enabled = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/enable'),
    );
    await page.getByRole('menuitem', { name: 'Enable', exact: true }).click();
    expect((await enabled).status()).toBe(204);
    await openDetails(page, 'More');
    const synced = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/sync'),
    );
    const refreshed = page.waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/_pb/sources',
    );
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    expect((await synced).status()).toBe(202);
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByRole('status').filter({ hasText: 'Sync requested.' })).toBeVisible();
    await openDetails(page, 'More');
    await page.getByRole('menuitem', { name: 'Set credential', exact: true }).click();
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
    await openDetails(page, 'More');
    await expect(page.getByRole('menuitem', { name: 'Set credential', exact: true })).toBeVisible();
    await assertSecretAbsent(page, material);
  });

  test('opens source dialogs through More with the keyboard on desktop and mobile', async ({
    page,
    admin,
  }) => {
    await confirmIdentity(page, admin);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await go(page, 'sources');
      const row = page.getByRole('row').filter({ hasText: 'Browser fixture source' });
      const more = row.getByRole('button', { name: /^More actions for / });
      await expect(row.getByText('Edit source', { exact: true })).toHaveCount(0);
      const scrollTop = () =>
        row.evaluate((element) => element.closest('.table-scroll')!.scrollTop);
      expect(await scrollTop()).toBe(0);
      await more.focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('menuitem', { name: 'Registered names', exact: true }),
      ).toBeVisible();
      const menu = page.getByRole('menu');
      expect(
        await menu.evaluate((element) => element.closest('.list-card, .table-scroll')),
      ).toBeNull();
      const last = page.getByRole('menuitem', { name: 'Registered names', exact: true });
      expect(
        await last.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit === element || element.contains(hit);
        }),
      ).toBe(true);
      expect(await scrollTop()).toBe(0);
      await page.keyboard.press('Escape');
      await expect(more).toBeFocused();
      await expect(
        page.getByRole('menuitem', { name: 'Registered names', exact: true }),
      ).not.toBeVisible();
      await page.keyboard.press('Space');
      await page.getByRole('menuitem', { name: 'Registered names', exact: true }).focus();
      await page.keyboard.press('Enter');
      const names = activeDialog(page, 'Registered names');
      await expect(names).toBeVisible();
      await expect(names.getByLabel('Registered pattern', { exact: true })).toBeVisible();
      await assertLayout(page);
      await names.getByRole('button', { name: 'Close', exact: true }).click();
      await more.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Set credential', exact: true }).focus();
      await page.keyboard.press('Enter');
      const credential = activeDialog(page, 'Set credential');
      await expect(credential).toBeVisible();
      await expect(credential.getByLabel('Credential kind', { exact: true })).toBeVisible();
      await assertLayout(page);
      await page.keyboard.press('Escape');
      await expect(credential).toHaveCount(0);
    }
  });

  test('creates a Composer source, attaches it, sets a credential and detaches it', async ({
    page,
    admin,
  }) => {
    await confirmIdentity(page, admin);
    await go(page, 'sources');
    await page.locator('details.filter-toolbar > summary').click();
    await page.getByLabel('Name (loaded sources)', { exact: true }).fill('No matching source');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.getByText('No sources match these filters.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    const create = activeDialog(page, 'Add source');
    await expect(create).toBeVisible();
    await create.getByRole('radio', { name: 'npm', exact: true }).check();
    await create.getByRole('radio', { name: /^Private npm registry/ }).check();
    await expect(create.getByLabel('Package scopes (one per line)', { exact: true })).toBeVisible();
    await expect(create.getByLabel('Package names (one per line)', { exact: true })).toHaveCount(0);
    await expect(
      create
        .getByRole('group', { name: 'Source type', exact: true })
        .locator('label > span > span:first-child'),
    ).toHaveText(['npmjs proxy', 'Private npm registry']);
    await create.getByRole('radio', { name: 'Composer', exact: true }).check();
    await create.getByRole('radio', { name: /^Composer repository/ }).check();
    await expect(create.getByLabel('Package scopes (one per line)', { exact: true })).toHaveCount(
      0,
    );
    await create
      .getByLabel('Source name (required)', { exact: true })
      .fill('Browser Composer repository');
    await create
      .getByLabel('Repository URL (required)', { exact: true })
      .fill('https://composer.example.test');
    await create
      .getByLabel('Package names (one per line)', { exact: true })
      .fill('browser/package');
    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/_pb/sources',
    );
    await create.getByRole('button', { name: 'Add source', exact: true }).click();
    expect((await created).status()).toBe(201);
    await expect(create).toHaveCount(0);
    await expect(
      page.getByRole('combobox', { name: 'Credential kind', exact: true }),
    ).toBeVisible();
    await activeDialog(page, 'Set credential')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    const sourceRow = () =>
      page.getByRole('row').filter({ hasText: 'Browser Composer repository' });
    await expect(sourceRow()).toBeVisible();

    await sourceRow().getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = activeDialog(page, 'Edit source');
    await edit.getByText('Advanced settings', { exact: true }).click();
    await edit.getByLabel('Sync interval (seconds)', { exact: true }).fill('600');
    await edit.getByLabel('Replace type-specific configuration', { exact: true }).check();
    await edit.getByLabel('Package names (one per line)', { exact: true }).fill('browser/updated');
    const updated = page.waitForResponse(
      (r) =>
        r.request().method() === 'PATCH' &&
        /\/_pb\/sources\/[^/]+$/.test(new URL(r.url()).pathname),
    );
    await edit.getByRole('button', { name: 'Save source', exact: true }).click();
    const updateResponse = await updated;
    expect(updateResponse.status()).toBe(204);
    expect(updateResponse.request().postDataJSON()).toMatchObject({
      pollIntervalSeconds: 600,
      config: { selection: { packages: ['browser/updated'] } },
    });
    await expect(edit).toHaveCount(0);

    await go(page, 'sources', 'project=browser-fixture');
    await expect(sourceRow()).toBeVisible();
    const attached = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/attachment'),
    );
    await sourceRow().getByRole('button', { name: 'Attach', exact: true }).click();
    expect((await attached).status()).toBe(204);
    await expect(sourceRow().getByRole('button', { name: 'Detach', exact: true })).toBeVisible();

    await go(page, 'sources');
    await sourceRow().getByText('More', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Set credential', exact: true }).click();
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

    await go(page, 'sources', 'project=browser-fixture');
    await sourceRow().getByRole('button', { name: 'Detach', exact: true }).click();
    const detach = activeDialog(page, 'Detach?');
    await expect(detach).toContainText('Browser Composer repository');
    await expect(detach).toContainText('Project: browser-fixture');
    await detach.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(sourceRow().getByRole('button', { name: 'Detach', exact: true })).toBeVisible();
    await sourceRow().getByRole('button', { name: 'Detach', exact: true }).click();
    const detached = page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith('/attachment'),
    );
    await activeDialog(page, 'Detach?')
      .getByRole('button', { name: 'Confirm detach', exact: true })
      .click();
    expect((await detached).status()).toBe(204);
    await expect(sourceRow().getByRole('button', { name: 'Attach', exact: true })).toBeVisible();
    await assertSecretAbsent(page, material);
  });

  test('creates, enables and requests sync for a project-owned Composer source', async ({
    page,
    admin,
  }) => {
    await confirmIdentity(page, admin);
    await page
      .getByRole('combobox', { name: 'Scope', exact: true })
      .selectOption('browser-fixture');
    await go(page, 'sources', 'project=browser-fixture');
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    const create = activeDialog(page, 'Add source');
    await create.getByRole('radio', { name: 'Composer', exact: true }).check();
    await create.getByRole('radio', { name: /^Composer repository/ }).check();
    await create
      .getByLabel('Source name (required)', { exact: true })
      .fill('Browser project Composer repository');
    await create
      .getByLabel('Repository URL (required)', { exact: true })
      .fill('https://composer.example.test');
    await create
      .getByLabel('Package names (one per line)', { exact: true })
      .fill('browser/project-package');
    const created = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === '/_pb/projects/browser-fixture/sources',
    );
    await create.getByRole('button', { name: 'Add source', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    await expect(create).toHaveCount(0);
    await activeDialog(page, 'Set credential')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    const sourceRow = () =>
      page.getByRole('row').filter({ hasText: 'Browser project Composer repository' });
    await expect(sourceRow().getByText('Paused', { exact: true }).first()).toBeVisible();
    await sourceRow().getByText('More', { exact: true }).click();
    await expect(sourceRow().getByRole('button', { name: 'Sync now', exact: true })).toBeDisabled();
    await page.getByRole('menuitem', { name: 'Registered names', exact: true }).click();
    await page.getByLabel('Registered pattern', { exact: true }).fill('browser/project-package');
    const registered = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && new URL(r.url()).pathname === `/_pb/sources/${id}/names`,
    );
    await page.getByRole('button', { name: 'Add name', exact: true }).click();
    expect((await registered).status()).toBe(201);
    const enabled = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/_pb/sources/${id}/enable`,
    );
    await activeDialog(page, 'Registered names')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await sourceRow().getByText('More', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Enable', exact: true }).click();
    expect((await enabled).status()).toBe(204);
    await expect(sourceRow().getByText('Paused', { exact: true })).toHaveCount(0);
    await expect(sourceRow().getByText('Active', { exact: true }).first()).toBeVisible();
    const nextPoll = () =>
      sourceRow()
        .getByText(/^Next poll:/)
        .first()
        .locator('time');
    const previousPoll = await nextPoll().getAttribute('datetime');
    const synced = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/_pb/projects/browser-fixture/sources/${id}/sync`,
    );
    const refreshed = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        new URL(r.url()).pathname === '/_pb/projects/browser-fixture/sources',
    );
    await sourceRow().getByRole('button', { name: 'Sync now', exact: true }).click();
    expect((await synced).status()).toBe(202);
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByRole('status').filter({ hasText: 'Sync requested.' })).toBeVisible();
    await expect(nextPoll()).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
    await expect(nextPoll()).not.toHaveAttribute('datetime', previousPoll!);
    await expect(sourceRow().getByText('Paused', { exact: true })).toHaveCount(0);
    if (!(await page.getByRole('menuitem', { name: 'Pause source…', exact: true }).isVisible())) {
      await sourceRow().getByText('More', { exact: true }).click();
    }
    await page.getByRole('menuitem', { name: 'Pause source…', exact: true }).click();
    const paused = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/_pb/projects/browser-fixture/sources/${id}/pause`,
    );
    await activeDialog(page, 'Pause?')
      .getByRole('button', { name: 'Confirm pause', exact: true })
      .click();
    expect((await paused).status()).toBe(204);
    await expect(sourceRow().getByText('Paused', { exact: true }).first()).toBeVisible();
    await go(page, 'sources');
    await page.getByRole('combobox', { name: 'Ownership', exact: true }).selectOption('project');
    await expect(sourceRow()).toBeVisible();
    await expect(sourceRow().getByText(/^Project:/)).toBeVisible();
    await expect(sourceRow().getByText('Paused', { exact: true }).first()).toBeVisible();
    await sourceRow().getByText('More', { exact: true }).click();
    const enabledFromOrganization = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/_pb/sources/${id}/enable`,
    );
    await page.getByRole('menuitem', { name: 'Enable', exact: true }).click();
    expect((await enabledFromOrganization).status()).toBe(204);
    await expect(sourceRow().getByText('Active', { exact: true }).first()).toBeVisible();
    await expect(sourceRow().getByText('Paused', { exact: true })).toHaveCount(0);
    await page
      .getByRole('combobox', { name: 'Ownership', exact: true })
      .selectOption('organization');
    await expect(sourceRow()).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Ownership', exact: true }).selectOption('all');
    await expect(sourceRow()).toBeVisible();
  });

  test('creates a GitHub token source and saves its bearer credential', async ({ page, admin }) => {
    await confirmIdentity(page, admin);
    await go(page, 'sources');
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    const create = activeDialog(page, 'Add source');
    await create.getByLabel('Source name (required)', { exact: true }).fill('Browser GitHub token');
    await create.getByRole('radio', { name: /^Git repository/ }).check();
    await expect(
      create
        .getByRole('group', { name: 'GitHub authentication', exact: true })
        .locator('label > span > span:first-child'),
    ).toHaveText(['GitHub App', 'Personal access token']);
    await expect(
      create.getByLabel('GitHub App installation ID (required)', { exact: true }),
    ).toBeVisible();
    await create.getByRole('radio', { name: /^Personal access token/ }).check();
    await expect(
      create.getByLabel('GitHub App installation ID (required)', { exact: true }),
    ).toHaveCount(0);
    await create.getByLabel('GitHub repository (required)', { exact: true }).fill('browser/token');
    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/_pb/sources',
    );
    await create.getByRole('button', { name: 'Add source', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON().config).toEqual({
      provider: 'github',
      repository: 'browser/token',
      refs: { tags: true, branches: [] },
    });
    await expect(page.getByLabel('Credential kind', { exact: true })).toHaveValue('bearer');
    const material = randomBytes(32).toString('base64url');
    await fillSecret(page.getByLabel('token', { exact: true }), material);
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/credential'),
    );
    await page.getByRole('button', { name: 'Save credential', exact: true }).click();
    expect((await saved).status()).toBe(204);
    await expect(page.getByRole('status').filter({ hasText: 'credential set' })).toBeVisible();
    await assertSecretAbsent(page, material);
  });

  test('shows disjoint sync counts and polls retrying packages until completion', async ({
    page,
    admin,
  }) => {
    await confirmIdentity(page, admin);
    let phase: 'idle' | 'retrying' | 'complete' = 'idle';
    const generation = 'a'.repeat(64);
    await page.route(
      (url) => url.pathname === '/_pb/sources',
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.items = body.items.map((source: { name: string; status: string }) =>
          source.name === 'Browser fixture source'
            ? {
                ...source,
                status: 'active',
                ...(phase === 'idle'
                  ? {}
                  : {
                      sync: {
                        generation,
                        listing: false,
                        queued: 0,
                        running: 0,
                        retrying: phase === 'retrying' ? 1 : 0,
                        failed: 0,
                        completed: phase === 'retrying' ? 2 : 3,
                        errors: phase === 'retrying' ? [{ code: 'rate_limited', count: 1 }] : [],
                      },
                    }),
              }
            : source,
        );
        await route.fulfill({ response, json: body });
      },
    );
    await page.route('**/_pb/sources/*/sync', async (route) => {
      phase = 'retrying';
      await route.fulfill({ status: 202, json: { requested: true } });
    });
    await go(page, 'sources');
    const row = page.getByRole('row').filter({ hasText: 'Browser fixture source' });
    await row.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect(
      row.getByText(/0 queued.*0 running.*1 retrying.*0 failed.*2 completed/),
    ).toBeVisible();
    await expect(row.getByText('rate_limited', { exact: true })).toBeVisible();
    phase = 'complete';
    await expect(
      row.getByText(/0 queued.*0 running.*0 retrying.*0 failed.*3 completed/),
    ).toBeVisible();
    await expect(row.getByText('rate_limited', { exact: true })).toHaveCount(0);
    await assertLayout(page);
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('offers only the repository providers the Node runtime serves', async ({ page, admin }) => {
    await confirmIdentity(page, admin);
    const listed = page.waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/_pb/sources',
    );
    await go(page, 'sources');
    expect((await (await listed).json()).vcsProviders).toEqual(['github', 'git', 'ssh']);
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    const create = activeDialog(page, 'Add source');
    await create.getByRole('radio', { name: /^Git repository/ }).check();
    const provider = create.getByLabel('Repository provider', { exact: true });
    await expect(provider.locator('option')).toHaveText([
      'GitHub',
      'Git over HTTP(S)',
      'Git over SSH',
    ]);
    await expect(create.getByText(/Node runtime/)).toHaveCount(0);
    await provider.selectOption('git');
    await expect(create.getByLabel('Git repository URL (required)', { exact: true })).toBeVisible();
  });

  for (const transport of ['no-cors fetch', 'HTML form'] as const) {
    test(`refuses a cross-origin POST from ${transport} with no auth state change`, async ({
      context,
      broker,
      admin,
    }) => {
      void admin;
      const readSession = async () => {
        // A URL-filtered lookup drops the Secure __Host- cookies on plain-http loopback.
        const cookies = await context.cookies();
        const session = await context.request
          .get(`${broker.origin}/_pb/session`, {
            headers: { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') },
            maxRedirects: 0,
          })
          .catch(() => {
            throw new Error('session API read failed');
          });
        expect(session.status()).toBe(200);
        const body = (await session.json().catch(() => {
          throw new Error('session API response did not match its contract');
        })) as { user: { id: string }; reauthFresh: boolean; expiresAt: string };
        return { userId: body.user.id, reauthFresh: body.reauthFresh, expiresAt: body.expiresAt };
      };
      const attack = await context.newPage();
      try {
        await attack.goto(otherOrigin);
        const sessionBefore = await readSession();
        const before = authState(broker);
        if (transport === 'HTML form') {
          await attack.evaluate((origin) => {
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = `${origin}/_pb/auth/local/login`;
            form.enctype = 'text/plain';
            const input = document.createElement('input');
            input.name = '{"padding":"';
            input.value = '"}';
            const submit = document.createElement('button');
            submit.type = 'submit';
            submit.textContent = 'Submit cross-origin form';
            form.append(input, submit);
            document.body.append(form);
          }, broker.origin);
        }
        const [response] = await Promise.all([
          attack.waitForResponse(
            (r) =>
              r.request().method() === 'POST' &&
              r.url() === `${broker.origin}/_pb/auth/local/login`,
            { timeout: 10_000 },
          ),
          transport === 'HTML form'
            ? attack.getByRole('button', { name: 'Submit cross-origin form', exact: true }).click({
                timeout: 10_000,
                noWaitAfter: true,
              })
            : attack.evaluate((origin) => {
                const target = `${origin}/_pb/auth/local/login`;
                void fetch(target, {
                  method: 'POST',
                  mode: 'no-cors',
                  credentials: 'include',
                  body: '{}',
                });
              }, broker.origin),
        ]);
        expect(response.status()).toBe(403);
        expect(response.request().headers()['origin']).toBe(otherOrigin);
        if (transport === 'HTML form') {
          expect(response.request().isNavigationRequest()).toBe(true);
          expect(response.request().headers()['content-type']).toMatch(/^text\/plain\b/);
        }
        expect(await readSession()).toEqual(sessionBefore);
        expect(authState(broker)).toEqual(before);
      } finally {
        await attack.close();
      }
    });
  }

  function authState(broker: Fixture) {
    return fixtureDatabase(broker, (db, org) => ({
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
      test(`${route} list at ${width}px confines overflow to table containers`, async ({
        page,
        admin,
        broker,
      }) => {
        if (route === 'tokens') {
          await issueToken(page, admin);
          await go(page, 'projects');
        }
        await page.setViewportSize({ width, height: 900 });
        await go(page, route);
        const table = page.locator('table').filter({ has: page.locator('tbody tr') });
        await expect(table.first()).toBeVisible();
        const marker = {
          projects: 'Browser fixture with a long project name for narrow screens',
          access: fixtureDatabase(broker, (db, org) => {
            const role = db
              .prepare('SELECT role_id FROM access_grant WHERE org_id = ? AND scope = ?')
              .get(org, 'organization')?.role_id;
            if (typeof role !== 'string') throw new Error('fixture organization grant missing');
            return role;
          }),
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
    test(`access roles list at ${width}px confines overflow to its container`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await go(page, 'access', 'status=roles');
      await expect(
        page.locator('tbody').getByText('Organization Admin', { exact: true }).first(),
      ).toBeVisible();
      await assertLayout(page);
    });
  }

  for (const route of ['projects', 'access', 'sources', 'packages', 'tokens', 'audit']) {
    test(`${route} mobile filters expand and collapse`, async ({ page }) => {
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
    test(`external fixture ${kind} is aborted and the network guard reports failure`, async ({
      broker,
    }) => {
      const isolated = await browser.newContext({ serviceWorkers: 'block' });
      const check = await guardContext(isolated, broker.origin);
      try {
        const external = await isolated.newPage();
        await external.goto(otherOrigin);
        const blocked = external.waitForEvent('requestfailed');
        if (kind === 'redirect') {
          await external.goto(`${otherOrigin}/external-redirect`).catch(() => {});
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

  test('all visited UI pages have zero CSP violations and no injected style elements', async ({
    page,
  }) => {
    for (const route of [
      'projects',
      'access',
      'sources',
      'packages',
      'tokens',
      'audit',
      'import',
    ]) {
      await go(page, route);
      expect(await page.locator('style').count()).toBe(0);
    }
  });
});
