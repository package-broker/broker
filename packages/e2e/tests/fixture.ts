import { DatabaseSync } from 'node:sqlite';
import type { Fixture } from '../dist/browser/fixtures.js';
import {
  expect,
  type APIResponse,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';
export { base32Decode } from '../dist/browser/totp.js';
export { authCode } from '../dist/browser/ui-fixture.js';
import { allowedUrl as isAllowedUrl, forwardRequest } from '../dist/browser/ui-fixture.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`UI fixture requires ${name}; use scripts/ui-e2e.mjs`);
  return value;
}

export const otherOrigin = required('PB_UI_E2E_OTHER_ORIGIN');
export const packageTarget = {
  id: '01J00000000000000000000003',
  versionId: '01J00000000000000000000006',
  name: '@browser-fixture/a-long-package-name-for-horizontal-overflow',
  version: '1.0.0',
};
export function allowedUrl(raw: string, origin: string): boolean {
  return isAllowedUrl(raw, [origin, otherOrigin]);
}

export async function guardContext(
  context: BrowserContext,
  origin: string,
): Promise<() => Promise<void>> {
  const failures: string[] = [];
  await context.exposeBinding('__pbCspFailure', () => {
    failures.push('CSP violation or injected style element');
  });
  await context.addInitScript(() => {
    const record = () => {
      void (window as unknown as { __pbCspFailure(): Promise<void> })
        .__pbCspFailure()
        .catch(() => {});
    };
    window.addEventListener('securitypolicyviolation', record);
    new MutationObserver((records) => {
      if (!location.pathname.startsWith('/_pb/ui')) return;
      if (
        records.some((entry) =>
          [...entry.addedNodes].some(
            (node) =>
              node instanceof Element && (node.matches('style') || node.querySelector('style')),
          ),
        )
      )
        record();
    }).observe(document, { childList: true, subtree: true });
  });
  context.on('page', (page) => {
    page.on('console', (message) => {
      if (
        /content.security.policy|violates.*directive|refused to.*(script|style)|trusted.types/i.test(
          message.text(),
        )
      ) {
        failures.push('console CSP violation');
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame.url() !== 'about:blank' && !allowedUrl(frame.url(), origin))
        failures.push('navigation outside allowed origins');
    });
  });
  await context.route('**/*', async (route) => {
    try {
      // Redirected browser requests may bypass routing, so resolve the entire chain here.
      const request = route.request();
      const failure = await forwardRequest(
        {
          url: request.url(),
          method: request.method(),
          headers: await request.allHeaders(),
          data: request.postDataBuffer(),
        },
        [origin, otherOrigin],
        (url, options) => context.request.fetch(url, options),
        (response) => route.fulfill({ response }),
      );
      if (failure) {
        failures.push(failure);
        await route.abort('blockedbyclient');
      }
    } catch {
      // Playwright request errors can include cookie-bearing request headers.
      failures.push('loopback request could not complete');
      await route.abort('failed').catch(() => {});
    }
  });
  await context.routeWebSocket('**/*', (socket) => {
    failures.push('unexpected WebSocket request');
    socket.close();
  });
  return async () => {
    expect(failures, 'browser origin and CSP guard').toEqual([]);
    for (const page of context.pages()) {
      if (allowedUrl(page.url(), origin) && new URL(page.url()).pathname.startsWith('/_pb/ui')) {
        expect(await page.locator('style').count()).toBe(0);
      }
    }
  };
}

export async function readSecret(response: Response | APIResponse, field: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && field in body) {
      const value = (body as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    /* Response parse errors can include secret-bearing body fragments. */
  }
  throw new Error('secret response did not match its contract');
}

export async function fillSecret(locator: Locator, value: string): Promise<void> {
  try {
    await locator.fill(value);
  } catch {
    throw new Error('sensitive input could not be filled');
  }
}

export async function assertSecretAbsent(page: Page, secret: string): Promise<void> {
  expect((await page.content()).includes(secret), 'secret absent from page.content()').toBe(false);
  const absent = await page.evaluate((sensitive) => {
    const inputs = [...document.querySelectorAll('input, textarea')].map(
      (node) => (node as HTMLInputElement).value,
    );
    const storage = [sessionStorage, localStorage].flatMap((store) =>
      Array.from({ length: store.length }, (_, index) => {
        const key = store.key(index) ?? '';
        return `${key}\n${store.getItem(key) ?? ''}`;
      }),
    );
    return [...inputs, ...storage].every((value) => !value.includes(sensitive));
  }, secret);
  expect(absent, 'secret absent from input values, sessionStorage and localStorage').toBe(true);
}

export async function go(page: Page, route: string, query = ''): Promise<void> {
  await page.evaluate(
    (hash) => {
      window.location.hash = hash;
    },
    `#/${route}${query ? `?${query}` : ''}`,
  );
  await expect(
    page.getByRole('heading', { name: route[0]!.toUpperCase() + route.slice(1), exact: true }),
  ).toBeVisible();
}

export async function openDetails(page: Page, label: string): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(summary).toBeVisible();
  const open = await summary.evaluate((node) => node.parentElement?.hasAttribute('open'));
  if (!open) await summary.click();
}

export function activeDialog(page: Page, title: string): Locator {
  return page.locator('dialog[open]').filter({
    has: page.getByText(title, { exact: true }),
  });
}

export async function assertLayout(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator('table tbody tr').count(), { message: 'populated list table' })
    .toBeGreaterThan(0);
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll, 'no page-level horizontal overflow').toBeLessThanOrEqual(
    dimensions.width + 1,
  );
  const confined = await page.locator('table').evaluateAll((tables) =>
    tables.every((table) => {
      let parent = table.parentElement;
      while (parent && !['auto', 'scroll'].includes(getComputedStyle(parent).overflowX))
        parent = parent.parentElement;
      if (!parent || parent.clientWidth > innerWidth + 1) return false;
      if (parent.scrollWidth > parent.clientWidth + 1) {
        parent.scrollLeft = 20;
        const moved = parent.scrollLeft > 0;
        parent.scrollLeft = 0;
        return moved;
      }
      return true;
    }),
  );
  expect(confined, 'tables keep horizontal scrolling inside their container').toBe(true);
}

export function fixtureDatabase<T>(fixture: Fixture, run: (db: DatabaseSync, org: string) => T): T {
  if (!fixture.database) throw new Error('fixture database missing');
  const db = new DatabaseSync(fixture.database);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
    const org = db.prepare('SELECT id FROM organization WHERE slug = ?').get('e2e')?.id;
    if (typeof org !== 'string') throw new Error('fixture organization missing');
    return run(db, org);
  } finally {
    db.close();
  }
}

export function seedLists(fixture: Fixture): void {
  fixtureDatabase(fixture, (db, org) => {
    const project = '01J00000000000000000000001';
    const source = '01J00000000000000000000002';
    db.prepare('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)').run(
      project,
      org,
      'browser-fixture',
      'Browser fixture with a long project name for narrow screens',
    );
    db.prepare(
      "INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, status) VALUES (?, ?, ?, 'npm', 'npm_registry', ?, ?, 'paused')",
    ).run(
      source,
      org,
      'Browser fixture source',
      'https://registry.example.test',
      JSON.stringify({ scopes: ['@browser-fixture'], distHosts: [] }),
    );
    db.prepare(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name, description) VALUES (?, ?, ?, 'npm', ?, ?)",
    ).run(packageTarget.id, org, source, packageTarget.name, 'Browser fixture package');
    db.prepare(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES (?, ?, ?, ?, ?, ?, 'import_time', '{}')",
    ).run(
      packageTarget.versionId,
      org,
      packageTarget.id,
      packageTarget.version,
      packageTarget.version,
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO import_run (id, org_id, source_system, state, plan_hash, planned_count) VALUES (?, ?, 'satis', 'planned', ?, 1)",
    ).run('01J00000000000000000000004', org, 'a'.repeat(64));
    db.prepare(
      "INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type, target_id) VALUES (?, ?, 1, ?, ?, ?, 'system', 'project.create', 'project', ?)",
    ).run(
      '01J00000000000000000000005',
      org,
      '0'.repeat(64),
      '1'.repeat(64),
      new Date().toISOString(),
      project,
    );
  });
}
