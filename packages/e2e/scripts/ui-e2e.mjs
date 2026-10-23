#!/usr/bin/env node
if (process.env.CI !== 'true') {
  console.log('UI end-to-end tests run in CI only (D14)');
  console.log(
    'Run after pnpm build and pnpm bundle, with Chromium installed: CI=true node packages/e2e/scripts/ui-e2e.mjs',
  );
} else {
  await run();
}

async function run() {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { createServer } = await import('node:http');
  const { createRequire } = await import('node:module');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { REPO_ROOT } = await import('../dist/browser/fixtures.js');
  const scratch = await mkdtemp(join(tmpdir(), 'pb-ui-e2e-'));
  let child;
  const other = createServer((request, response) => {
    if (request.url === '/external-redirect') {
      response.writeHead(302, { location: 'https://example.invalid' });
      response.end();
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Second loopback origin</title>');
  });
  const stop = () => {
    child?.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await new Promise((resolve, reject) => {
      other.once('error', reject);
      other.listen(0, '127.0.0.1', resolve);
    });
    const address = other.address();
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    child = spawn(
      process.execPath,
      [
        cli,
        'test',
        '--config',
        fileURLToPath(new URL('./ui-playwright.config.mjs', import.meta.url)),
        ...process.argv.slice(2),
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PB_UI_E2E_OTHER_ORIGIN: `http://127.0.0.1:${address.port}`,
          PB_UI_E2E_OUTPUT: scratch,
          PLAYWRIGHT_NO_COPY_PROMPT: '1',
        },
        stdio: 'inherit',
      },
    );
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      console.error('UI end-to-end tests NOT RUN: loopback listener permission denied');
    }
    console.error(
      'UI end-to-end runner failed to start or complete; check the built Node fixture and local listener/browser permissions',
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await new Promise((resolve) => other.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
}
