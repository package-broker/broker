import assert from 'node:assert/strict';
import type { Runtime } from './local.js';

export interface StaleSealOutcome {
  outcome: string;
}

export function retentionBundle(bundle: string, runtime: Runtime): string {
  assert(!bundle.includes('let fixtureRetentionExecutor;'), 'RetentionSealerAlreadyPatched');
  const factory = /function createAuditSealRepository\((\w+), (\w+) = \{\}\) \{/;
  const matches = [...bundle.matchAll(new RegExp(factory, 'g'))];
  assert.equal(matches.length, 1, 'RetentionSealerPatchTargetMissing');
  const match = matches[0]!;
  bundle = bundle.replace(
    match[0],
    `let fixtureRetentionExecutor;
let fixtureRetentionSeal;
${match[0]}
  fixtureRetentionExecutor ??= ${match[1]};`,
  );
  const ready = '  app.get("/health/ready", async (c) => {';
  assert.equal(bundle.split(ready).length, 2, 'RetentionRoutePatchTargetMissing');
  // Only the disposable fixture bundle has this control route. The paused writer and
  // its competing jobs use the same production repository, executor and database.
  return bundle.replace(
    ready,
    `  app.post('/__fixture/stale-seal', async c => {
    const { orgId, operation } = await c.req.json();
    const executor = fixtureRetentionExecutor;
    const organizations = await executor.all({ sql: 'SELECT id FROM organization WHERE id = ?', params: [orgId] });
    if (organizations.length !== 1) return c.json({ error: 'FixtureOrganizationMissing' }, 409);
    if (operation === 'capture') {
      if (fixtureRetentionSeal) return c.json({ error: 'FixtureSealerAlreadyCaptured' }, 409);
      let release;
      let capture;
      const gate = new Promise(resolve => { release = resolve; });
      const captured = new Promise(resolve => { capture = resolve; });
      const paused = {
        driver: executor.driver,
        all: statement => executor.all(statement),
        async batch(statements) { capture(); await gate; return executor.batch(statements); }
      };
      const settled = createAuditSealRepository(paused).seal(orgContext(orgId));
      fixtureRetentionSeal = { orgId, release, settled };
      ${runtime === 'cloudflare' ? 'c.executionCtx.waitUntil(settled);' : 'settled.catch(() => {});'}
      const didCapture = await Promise.race([captured.then(() => true), settled.then(() => false)]);
      if (!didCapture) { fixtureRetentionSeal = undefined; return c.json({ error: 'FixtureSealerEmpty' }, 409); }
      return c.json({ captured: true });
    }
    if (operation !== 'release' || !fixtureRetentionSeal || fixtureRetentionSeal.orgId !== orgId)
      return c.json({ error: 'FixtureSealerNotCaptured' }, 409);
    const held = fixtureRetentionSeal;
    fixtureRetentionSeal = undefined;
    held.release();
    return c.json(await held.settled);
  });
${ready}`,
  );
}
