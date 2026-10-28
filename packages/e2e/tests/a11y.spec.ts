import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page } from '@playwright/test';
import { startNodeFixture, type Fixture } from '../dist/browser/fixtures.js';
import {
  activeDialog,
  authCode,
  base32Decode,
  fillSecret,
  fixtureDatabase,
  go,
  guardContext,
  openDetails,
  packageTarget,
  readSecret,
  seedLists,
} from './fixture.js';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ALLOWED_RULE_IDS: string[] = [];

type Admin = { password: string; enrollment: Uint8Array };
const test = base.extend<{ broker: Fixture; admin: Admin; adminPage: Page }>({
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
  context: async ({ browser, broker }, use) => {
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
  admin: async ({ context, broker }, use) => {
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
  adminPage: async ({ page, admin, broker }, use) => {
    void admin;
    await page.goto(`${broker.origin}/_pb/ui/`);
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await use(page);
  },
});

test.setTimeout(90_000);

async function scan(page: Page, state: string): Promise<void> {
  await test.step(`axe: ${state}`, async () => {
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .disableRules(ALLOWED_RULE_IDS)
      .analyze();
    // Keep DOM fragments, input values and fixture credentials out of failure output.
    const violations = results.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map(({ target }) => target),
    }));
    expect(violations, `${state}: rule id, impact and target selectors`).toEqual([]);
  });
}

async function scanDialog(page: Page, title: string): Promise<void> {
  const dialog = activeDialog(page, title);
  await expect(dialog).toBeVisible();
  await scan(page, title);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function confirmIdentity(page: Page, admin: Admin): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/reauth?return=%2Fprojects';
  });
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await scan(page, 'Reauthentication');
  await fillSecret(page.getByLabel('Password', { exact: true }), admin.password);
  await fillSecret(page.getByLabel('Authenticator code'), await authCode(admin.enrollment));
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
}

test('sign-in and first-admin setup at every stage', async ({ page, broker }) => {
  await page.goto(`${broker.origin}/_pb/ui/`);
  await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
  await scan(page, 'Sign in');
  await page.goto(`${broker.origin}/_pb/ui/#/setup`);
  await expect(page.getByRole('heading', { name: 'First-run setup', exact: true })).toBeVisible();
  await scan(page, 'First-admin setup in the app');
  await page.goto(`${broker.origin}/_pb/ui/setup`);
  await expect(page.getByLabel('Setup token')).toBeVisible();
  await scan(page, 'First-admin setup token');
  await fillSecret(page.getByLabel('Setup token'), broker.token);
  const started = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/_pb/auth/local/setup/start',
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const response = await started;
  expect(response.status()).toBe(200);
  const enrollment = base32Decode(await readSecret(response, 'secret'));
  await expect(page.locator('#setup-qr')).toBeVisible();
  await scan(page, 'First-admin authenticator enrollment');
  const password = `Browser-${randomBytes(24).toString('base64url')}!42`;
  await fillSecret(page.getByLabel('Password', { exact: true }), password);
  await fillSecret(page.getByLabel('Confirm password', { exact: true }), password);
  await fillSecret(
    page.getByLabel('Six digit code from your authenticator'),
    await authCode(enrollment, -1),
  );
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Setup complete', exact: true })).toBeVisible();
  await scan(page, 'First-admin setup complete');
});

for (const width of [1440, 390]) {
  for (const route of ['projects', 'access', 'sources', 'packages', 'tokens', 'audit', 'import']) {
    test(`${route} seeded admin page at ${width}px`, async ({ adminPage: page, admin }) => {
      await page.setViewportSize({ width, height: 900 });
      if (route === 'tokens') {
        await confirmIdentity(page, admin);
        await go(page, 'tokens');
        await page.getByLabel('Token list', { exact: true }).selectOption('personal');
        await page.getByRole('button', { name: 'New token', exact: true }).click();
        await page.getByRole('radio', { name: 'Me', exact: true }).check();
        await page.getByRole('radio', { name: 'All projects I can access', exact: true }).check();
        await page.getByLabel('Token name', { exact: true }).fill('Accessibility list token');
        const issued = page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/_pb/me/tokens',
        );
        await page.getByRole('button', { name: /^Create token$/, exact: true }).click();
        expect((await issued).status()).toBe(201);
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await go(page, 'projects');
      }
      await go(page, route);
      await expect(page.locator('tbody tr').first()).toBeVisible();
      if (width === 390) {
        await page.getByRole('button', { name: 'Main menu', exact: true }).click();
        const toolbars = page.locator('details.filter-toolbar');
        for (let index = 0; index < (await toolbars.count()); index++) {
          const toolbar = toolbars.nth(index);
          if (!(await toolbar.evaluate((node) => node.hasAttribute('open')))) {
            await toolbar.locator('> summary').click();
          }
          await expect(toolbar).toHaveJSProperty('open', true);
        }
      }
      await scan(page, `${route} at ${width}px`);
    });
  }

  test(`source dialogs and their conditional fields at ${width}px`, async ({ adminPage: page }) => {
    await page.setViewportSize({ width, height: 900 });
    await go(page, 'sources');
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    const add = activeDialog(page, 'Add source');
    await expect(add).toBeVisible();
    for (const ecosystem of ['Composer', 'npm']) {
      await add.getByRole('radio', { name: ecosystem, exact: true }).check();
      const types = add.getByRole('group', { name: 'Source type', exact: true }).getByRole('radio');
      const typeCount = await types.count();
      expect(typeCount, 'source types available for scanning').toBeGreaterThan(0);
      for (let index = 0; index < typeCount; index++) {
        await types.nth(index).check();
        await scan(page, `Add source: ${ecosystem} type ${index}`);
      }
    }
    await add.getByRole('button', { name: 'Close', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'Browser fixture source' });
    await row.getByRole('button', { name: /^Edit / }).click();
    const edit = activeDialog(page, 'Edit source');
    await expect(edit).toBeVisible();
    await scan(page, 'Edit source');
    await edit.getByText('Advanced settings', { exact: true }).click();
    await scan(page, 'Edit source advanced settings');
    await edit.getByRole('button', { name: 'Close', exact: true }).click();
    await openDetails(page, 'More');
    await page.getByRole('menuitem', { name: /^Set credential / }).click();
    const credential = activeDialog(page, 'Set credential');
    await expect(credential).toBeVisible();
    const kinds = await credential
      .getByLabel('Credential kind')
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(kinds.length, 'credential kinds available for scanning').toBeGreaterThan(0);
    for (const kind of kinds) {
      await credential.getByLabel('Credential kind').selectOption(kind);
      await scan(page, `Set credential: ${kind}`);
    }
    await credential.getByRole('button', { name: 'Close', exact: true }).click();
    await openDetails(page, 'More');
    await page.getByRole('menuitem', { name: /^Registered names / }).click();
    await scanDialog(page, 'Registered names');
  });

  test(`project forms and archive confirmation at ${width}px`, async ({ adminPage: page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openDetails(page, 'New project');
    await scan(page, 'New project form');
    await go(page, 'projects', 'project=browser-fixture');
    const settings = page.getByRole('region', { name: 'Project settings' });
    await expect(
      settings.getByRole('button', { name: 'Save settings', exact: true }),
    ).toBeEnabled();
    await scan(page, 'Project settings');
    await settings.getByRole('button', { name: 'Archive', exact: true }).click();
    await scanDialog(page, 'Archive?');
  });

  test(`access forms, grant and role confirmations at ${width}px`, async ({
    adminPage: page,
    admin,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await confirmIdentity(page, admin);
    await go(page, 'access');
    await openDetails(page, 'New grant');
    await scan(page, 'New grant form');
    await openDetails(page, 'Change role');
    await scan(page, 'Change role form');
    await page.getByRole('button', { name: 'Revoke grant', exact: true }).click();
    await scanDialog(page, 'Revoke grant?');
    await go(page, 'access', 'status=roles');
    await openDetails(page, 'New role');
    await scan(page, 'New role form');
    await page.getByLabel('Role key', { exact: true }).fill('a11y_role');
    await page.getByLabel('Role name', { exact: true }).fill('Accessibility role');
    await page.getByRole('button', { name: 'Create role', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'Accessibility role' });
    await expect(row).toBeVisible();
    await row
      .locator('summary')
      .filter({ hasText: /^Edit role$/ })
      .click();
    await scan(page, 'Edit role form');
    await row.getByRole('button', { name: 'Remove role', exact: true }).click();
    await scanDialog(page, 'Remove role?');
  });

  test(`token creation, secret and revoke confirmation at ${width}px`, async ({
    adminPage: page,
    admin,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await confirmIdentity(page, admin);
    await go(page, 'tokens');
    await page.getByLabel('Token list', { exact: true }).selectOption('personal');
    await page.getByRole('button', { name: 'New token', exact: true }).click();
    await page.getByRole('radio', { name: 'Me', exact: true }).check();
    await page.getByRole('radio', { name: 'All projects I can access', exact: true }).check();
    const issue = page.getByRole('button', { name: /^Create token$/, exact: true });
    await expect(issue).toBeEnabled();
    await scan(page, 'Issue personal token form');
    await page.getByLabel('Token name', { exact: true }).fill('Accessibility token');
    await issue.click();
    await expect(page.getByRole('region', { name: 'Token secret', exact: true })).toBeVisible();
    await scan(page, 'Token secret shown once');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Reload tokens', exact: true }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.getByRole('button', { name: 'Revoke', exact: true }).first().click();
    await scanDialog(page, 'Revoke?');
    await page.getByLabel('Token list', { exact: true }).selectOption('organization');
    await page.getByRole('button', { name: 'New token', exact: true }).click();
    await page.getByRole('radio', { name: 'A CI pipeline or service', exact: true }).check();
    await expect(page.getByRole('button', { name: /^Create token$/, exact: true })).toBeEnabled();
    await scan(page, 'Issue service token form');
    await openDetails(page, 'Service principals');
    await page.getByRole('button', { name: 'New service principal', exact: true }).click();
    await scan(page, 'Service principal form');
  });
}

test('package and held-action confirmations in their open states', async ({
  adminPage: page,
  admin,
  broker,
}) => {
  await go(page, 'packages', `package=${packageTarget.id}`);
  const versions = page.getByRole('region', {
    name: `Versions of ${packageTarget.name}`,
    exact: true,
  });
  await versions.getByRole('button', { name: 'Tombstone', exact: true }).click();
  await scanDialog(page, `Tombstone ${packageTarget.version}?`);
  fixtureDatabase(broker, (db, org) => {
    const changed = db
      .prepare('UPDATE session SET reauth_at = NULL WHERE org_id = ? AND revoked_at IS NULL')
      .run(org);
    expect(Number(changed.changes)).toBeGreaterThan(0);
  });
  await versions.getByRole('button', { name: 'Tombstone', exact: true }).click();
  await activeDialog(page, `Tombstone ${packageTarget.version}?`)
    .getByRole('button', { name: 'Confirm tombstone', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await scan(page, 'Reauthentication for held action');
  await fillSecret(page.getByLabel('Password', { exact: true }), admin.password);
  await fillSecret(page.getByLabel('Authenticator code'), await authCode(admin.enrollment));
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await scanDialog(page, 'Send the held action now?');
});
