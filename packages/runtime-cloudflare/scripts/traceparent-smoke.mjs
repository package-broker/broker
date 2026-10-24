import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const TRACED_ROUTE = '/_pb/openapi.json';

export async function buildTraceparentBundle(root, target, trusted) {
  const out = join(root, '.pb', `traceparent-${target}-${trusted}`);
  let config = join(root, 'fixtures', `observability-${trusted ? 'trusted' : 'base'}.config.ts`);
  if (process.argv.includes('--break') && process.argv.includes('traceparent')) {
    // Simulate build wiring that always trusts the header, ignoring the configured flag.
    await mkdir(out, { recursive: true });
    config = join(out, 'ignore-flag.config.ts');
    await writeFile(
      config,
      `import base from '../../fixtures/observability-trusted.config';\nexport default base;\n`,
    );
    console.log(`smoke:${target} --break traceparent: ignoring the trust flag`);
  }
  const build = spawn(
    process.execPath,
    [
      join(root, 'packages/cli/dist/bin.js'),
      'build',
      '--config',
      config,
      '--target',
      target,
      '--out',
      out,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  const [code, signal] = await once(build, 'exit');
  assert.equal(code, 0, `traceparent bundle build failed (${signal ?? code})`);
  return out;
}

export async function checkTraceparentCases({ trusted, request, records }) {
  const traceId = 'ab'.repeat(16);
  const spanId = 'cd'.repeat(8);
  for (const valid of [true, false]) {
    const label = `traceparent trusted=${trusted}, ${valid ? 'valid' : 'malformed'} header`;
    const before = records().length;
    const response = await request({
      traceparent: `${valid ? '00' : 'zz'}-${traceId}-${spanId}-01`,
    });
    assert.equal(response.status, 200, label);
    await response.text();
    let requests;
    const deadline = Date.now() + 2_000;
    do {
      requests = records()
        .slice(before)
        .filter((record) => record?.event === 'http.request' && record.route === TRACED_ROUTE);
      if (requests.length > 0) break;
      await delay(25);
    } while (Date.now() < deadline);
    assert.equal(requests.length, 1, `${label}: expected one http.request record`);
    const record = requests[0];
    assert.match(record.trace_id, /^[a-f0-9]{32}$/, label);
    assert.notEqual(record.trace_id, '0'.repeat(32), label);
    assert.equal(record.trace_id === traceId, trusted && valid, `${label}: inbound trace id trust`);
    assert.match(record.span_id, /^[a-f0-9]{16}$/, label);
    assert.notEqual(record.span_id, '0'.repeat(16), label);
    assert.notEqual(record.span_id, spanId, `${label}: expected a child span`);
    console.log(`smoke ${label} passed`);
  }
}
