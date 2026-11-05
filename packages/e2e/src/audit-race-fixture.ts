import assert from 'node:assert/strict';

// These controls exist only in a disposable bundle. Every competing repository call
// belongs to the same request, including D1 I/O after a paused call resumes.
export function auditRaceBundle(bundle: string, route: string, body: string): string {
  const capture = (pattern: RegExp, injected: (match: RegExpMatchArray) => string) => {
    const matches = [...bundle.matchAll(new RegExp(pattern, 'g'))];
    assert.equal(matches.length, 1, 'AuditRacePatchTargetMissing');
    bundle = bundle.replace(matches[0]![0], injected(matches[0]!));
  };
  assert(!bundle.includes('let fixtureAuditExecutor;'), 'AuditRaceAlreadyPatched');
  capture(
    /function createAuditExportRepository\((\w+)\) \{/,
    (m) => `${m[0]}\n  if (${m[1]}.driver !== 'none') fixtureAuditExecutor = ${m[1]};`,
  );
  capture(
    /function auditExportJob\((\w+), (\w+)\) \{/,
    (m) => `${m[0]}\n  fixtureAuditExports.set(${m[2]}.id, { port: ${m[1]}, options: ${m[2]} });`,
  );
  const ready = '  app.get("/health/ready", async (c) => {';
  assert.equal(bundle.split(ready).length, 2, 'AuditRaceRoutePatchTargetMissing');
  return `let fixtureAuditExecutor;
const fixtureAuditExports = new Map();
${bundle.replace(
  ready,
  `  app.post(${JSON.stringify(route)}, async c => {
    const { orgId } = await c.req.json();
    const org = await resolveOrg(c.req.raw);
    if (org.orgId !== orgId) return c.json({ error: 'ForeignFixtureOrganization' }, 409);
    const executor = fixtureAuditExecutor;
    const registration = fixtureAuditExports.get('webhook');
    if (!executor || !registration) return c.json({ error: 'FixtureAuditUnavailable' }, 409);
    const { port, options } = registration;
    const run = (sql, params) => executor.batch([{ sql, params }]);
    const readChain = async () => (await executor.all({
      sql: 'SELECT * FROM audit_chain WHERE org_id = ?', params: [orgId]
    }))[0];
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    const jobs = createJobRepository(executor);
    const jobId = ulid();
    await run("INSERT INTO job (id, org_id, type, resource_key) VALUES (?, ?, 'core:audit-export-webhook:v1', 'audit-export:webhook')", [jobId, orgId]);
    const claim = () => jobs.claim(org, ulid(), { id: jobId,
      types: ['core:audit-export-webhook:v1'], leaseSeconds: 60, maxRunning: 100 });
    const lease = await claim();
    if (!lease) throw new Error('FixtureExportLeaseMissing');
    const exportOnce = (activePort, activeOptions, activeLease, signal) => exportAuditBatch(
      activePort, org, systemMutationFence('audit-export', activeLease, {}), activeOptions, signal
    );
    try {
      ${body}
    } finally {
      await run('DELETE FROM job WHERE org_id = ? AND id = ?', [orgId, lease.id]);
    }
  });
${ready}`,
)}`;
}

export const overlapRace = `
      const before = await port.read(org, 'webhook');
      const cancellation = new AbortController();
      let cancellationSaves = 0;
      const cancelled = await exportOnce({ ...port,
        async save(org, fence, expected, next, generation, effects) {
          if (next.progressSeq > expected.sink.progressSeq) cancellationSaves++;
          return port.save(org, fence, expected, next, generation, effects);
        }
      }, { ...options, sink: { ...options.sink,
        async deliver(batch, signal) {
          const accepted = await options.sink.deliver(batch, signal);
          cancellation.abort();
          return accepted;
        }
      } }, lease, cancellation.signal);
      const oldReady = deferred();
      const releaseOld = deferred();
      const replacementReady = deferred();
      const releaseReplacement = deferred();
      const attempts = [];
      let staleExpected;
      const observedPort = { ...port,
        async save(org, fence, expected, next, generation, effects) {
          const terminal = next.progressSeq > expected.sink.progressSeq;
          if (terminal && fence.job.fence === lease.fence) {
            staleExpected = expected;
            oldReady.resolve();
            await releaseOld.promise;
          } else if (!terminal && fence.job.fence > lease.fence) {
            replacementReady.resolve();
            await releaseReplacement.promise;
          }
          const saved = await port.save(org, fence, expected, next, generation, effects);
          if (terminal) attempts.push({ fence: fence.job.fence, saved });
          return saved;
        }
      };
      const signal = new AbortController().signal;
      const old = exportOnce(observedPort, options, lease, signal);
      let replacement;
      try {
        if (!await Promise.race([oldReady.promise.then(() => true), old.then(() => false)]))
          throw new Error('FixtureOldSaveNotReached');
        const independent = fixtureAuditExports.get('otlp');
        if (!independent) throw new Error('FixtureIndependentSinkMissing');
        const independentLease = { id: ulid(), owner: ulid(), fence: 1 };
        let independentOutcome;
        let independentThrough;
        await run("INSERT INTO job (id, org_id, type, resource_key, state, lease_owner, lease_until, fence) VALUES (?, ?, 'core:audit-export-otlp:v1', 'audit-export:otlp', 'running', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'), ?)",
          [independentLease.id, orgId, independentLease.owner, independentLease.fence]);
        try {
          independentOutcome = await exportOnce(independent.port, independent.options, independentLease, signal);
          independentThrough = (await independent.port.read(org, 'otlp')).sink.progressSeq;
        } finally {
          await run('DELETE FROM job WHERE org_id = ? AND id = ?', [orgId, independentLease.id]);
        }
        await run("UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND id = ? AND lease_owner = ? AND fence = ?",
          [orgId, lease.id, lease.owner, lease.fence]);
        await jobs.reap(org, 50);
        await run("UPDATE job SET run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND id = ?", [orgId, lease.id]);
        const fresh = await claim();
        if (!fresh) throw new Error('FixtureReplacementLeaseMissing');
        let heartbeatRefused = false;
        try { await jobs.heartbeat(org, lease); } catch (error) {
          if (error.name !== 'StaleFenceError') throw error;
          heartbeatRefused = true;
        }
        replacement = exportOnce(observedPort, options, fresh, signal);
        if (!await Promise.race([replacementReady.promise.then(() => true), replacement.then(() => false)]))
          throw new Error('FixtureReplacementNotReached');
        const frozen = await port.read(org, 'webhook');
        const sameSnapshot = Object.keys(staleExpected).every(key => key === 'sink'
          ? Object.keys(staleExpected.sink).every(field => frozen.sink[field] === staleExpected.sink[field])
          : frozen[key] === staleExpected[key]);
        if (!sameSnapshot) throw new Error('FixtureStaleSnapshotChanged');
        releaseOld.resolve();
        const staleOutcome = await old;
        const afterStale = await port.read(org, 'webhook');
        releaseReplacement.resolve();
        const replacementOutcome = await replacement;
        return c.json({ cancelled, cancellationSaves, heartbeatRefused, staleOutcome, replacementOutcome, attempts,
          oldFence: lease.fence, replacementFence: fresh.fence,
          independentOutcome, independentThrough, before: before.sink.progressSeq, afterStale: afterStale.sink.progressSeq,
          sameSnapshot, frozen: Boolean(frozen.sink.inflightBody),
          after: (await port.read(org, 'webhook')).sink.progressSeq });
      } finally {
        releaseOld.resolve();
        releaseReplacement.resolve();
        await Promise.allSettled([old, replacement]);
      }
`;

export const staleSealRace = `
      const captured = deferred();
      const release = deferred();
      let attempted = 0;
      const paused = { driver: executor.driver, all: statement => executor.all(statement),
        async batch(statements) {
          captured.resolve();
          await release.promise;
          attempted++;
          return executor.batch(statements);
        }
      };
      const stale = createAuditSealRepository(paused).seal(org);
      try {
        if (!await Promise.race([captured.promise.then(() => true), stale.then(() => false)]))
          throw new Error('FixtureStaleSealNotReached');
        const winner = await createAuditSealRepository(executor).seal(org);
        const sealed = await readChain();
        await run('UPDATE audit_sink SET next_attempt_at = NULL WHERE org_id = ? AND sink_id = ?', [orgId, 'webhook']);
        const delivered = await exportOnce(port, options, lease, new AbortController().signal);
        const ack = (await port.read(org, 'webhook')).sink;
        const prune = await pruneAudit(createAuditPruneRepository(executor), org, {
          generation: options.generation, configuredSinkIds: ['webhook'], trailActive: false
        });
        const pruned = await readChain();
        release.resolve();
        const outcome = await stale;
        return c.json({ outcome: outcome.outcome, attempted, winner: winner.outcome, delivered,
          sealed, ack: { progress_seq: ack.progressSeq, custody_seq: ack.custodySeq },
          prune: prune.outcome, pruned, afterStale: await readChain() });
      } finally {
        release.resolve();
        await stale;
      }
`;
