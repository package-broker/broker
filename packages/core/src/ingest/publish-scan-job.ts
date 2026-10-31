import { auditEvent } from '../audit/actions.js';
import { redactValue } from '../audit/redact.js';
import type {
  PublishInspection,
  PublishesRepository,
  PublishScanState,
  PublishScannerVerdict,
} from '../db/publishes.js';
import type { BlobStore } from '../platform/blob.js';
import { JOB_LEASE_SECONDS } from '../platform/job-repository.js';
import { jobLeaseOf } from '../platform/job-fences.js';
import { defineJob, JobError, type JobContext } from '../platform/jobs.js';
import type { PublishPolicyDefinition } from '../plugin.js';

export const PUBLISH_SCAN_JOB = 'core:publish-scan:v1';
export const SCANNER_TIMEOUT_MS = 60_000;

export const PUBLISH_SCAN_JOB_OPTIONS = Object.freeze({
  name: 'publish-scan',
  version: 1,
  maxAttempts: 3,
  validate(input: unknown) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      !input.id ||
      input.id.length > 128
    )
      throw new JobError('invalid_payload');
    return { id: input.id };
  },
});

export function createPublishScanJob(deps: {
  readonly publishes: PublishesRepository;
  readonly scanners: readonly PublishPolicyDefinition[];
  readonly blob: Pick<BlobStore, 'get'>;
}) {
  return defineJob({
    ...PUBLISH_SCAN_JOB_OPTIONS,
    async handler({ id }, job) {
      if (!jobLeaseOf(job)) throw new JobError('lease_lost');
      let item = await deps.publishes.get(job.org, id);
      if (!item || !['queued', 'running'].includes(item.scanState)) return;
      const change = async (
        scanState: PublishScanState,
        verdicts: readonly PublishScannerVerdict[] = [],
      ) => {
        for (;;) {
          if (job.signal.aborted && !['queued', 'failed'].includes(scanState))
            throw new JobError('aborted');
          const current = item;
          if (!current) return false;
          const event = scanEvent(job, current, scanState, verdicts.at(-1));
          const result = await deps.publishes.scan(job.org, job.fences!.verifier(), {
            id,
            expectedRevision: current.revision,
            expectedApprovalState: current.approvalState,
            expectedScanState: current.scanState,
            now: job.ports.clock.now().toISOString(),
            event,
            scanState,
            verdicts,
          });
          item = await deps.publishes.get(job.org, id);
          if (result.changed) return true;
          if (
            (!['allowed', 'denied'].includes(scanState) && current.scanState !== 'running') ||
            !item ||
            item.scanState !== 'running' ||
            item.revision === current.revision
          )
            return false;
        }
      };
      if (!item) return;
      if (item.scanAttempts >= 3) {
        await change('failed');
        return;
      }
      if (item.scanState === 'running' && !(await change('queued'))) return;
      if (!(await change('running'))) return;
      const verdicts: PublishScannerVerdict[] = [];
      try {
        if (!item || !item.requiredScanners.length || item.requiredScanners.length > 3) {
          await change('failed');
          return;
        }
        const scanning = item;
        const data = await deps.publishes.scanInput(job.org, id);
        if (!data) throw new JobError('handler_error');
        for (const scannerId of scanning.requiredScanners) {
          const matches = deps.scanners.filter((entry) => entry.id === scannerId);
          const scanner = matches[0];
          if (matches.length !== 1 || !scanner) {
            await change('failed');
            return;
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), SCANNER_TIMEOUT_MS);
          const signal = AbortSignal.any([job.signal, controller.signal]);
          const streams: ReadableStream<Uint8Array>[] = [];
          try {
            const aborted = new Promise<never>((_resolve, reject) => {
              if (signal.aborted) reject(new JobError('timeout'));
              else
                signal.addEventListener('abort', () => reject(new JobError('timeout')), {
                  once: true,
                });
            });
            const result = await Promise.race([
              aborted,
              Promise.resolve().then(() =>
                scanner.inspect(job.org, {
                  name: scanning.packageName,
                  version: scanning.version,
                  manifest: data.manifest,
                  integrity: data.integrity,
                  sizeBytes: data.sizeBytes,
                  signal,
                  async openTarball() {
                    signal.throwIfAborted();
                    const blob = await deps.blob.get(job.org, data.sha256);
                    if (!blob) throw new JobError('handler_error');
                    if (signal.aborted) {
                      await blob.body.cancel().catch(() => undefined);
                      signal.throwIfAborted();
                    }
                    streams.push(blob.body);
                    return blob.body;
                  },
                }),
              ),
            ]);
            if (!result || !['allow', 'deny'].includes(result.verdict))
              throw new JobError('handler_error');
            const safe =
              result.reason === undefined ? undefined : redactValue(result.reason, 1000, 'reason');
            verdicts.push({
              plugin: scannerId,
              verdict: result.verdict,
              ...(safe?.ok &&
              safe.value === result.reason &&
              new TextEncoder().encode(result.reason).length <= 1000
                ? { reason: result.reason }
                : {}),
            });
            if (result.verdict === 'deny') {
              await change('denied', verdicts);
              return;
            }
          } finally {
            clearTimeout(timer);
            controller.abort();
            for (const stream of streams) void stream.cancel().catch(() => undefined);
          }
        }
        await change('allowed', verdicts);
      } catch {
        const exhausted = (item?.scanAttempts ?? 3) >= 3 || job.attempt >= 3;
        if (item?.scanState === 'running') await change(exhausted ? 'failed' : 'queued');
        if (job.signal.aborted) throw new JobError('aborted');
        throw new JobError('handler_error');
      }
    },
  });
}

function scanEvent(
  job: JobContext,
  item: PublishInspection,
  state: string,
  verdict?: PublishScannerVerdict,
) {
  const event = auditEvent({
    id: job.ports.ids.ulid(),
    now: job.ports.clock.now().toISOString(),
    action: 'publish.scan',
    actor: { type: 'system', id: null },
    target: { type: 'publish', id: item.id },
    context: {
      opId: job.ports.ids.ulid(),
      requestId: job.ports.ids.ulid(),
      sourceIp: null,
      tokenSelector: null,
    },
    changes: {
      verdict: { new: verdict?.verdict ?? state },
      ...(verdict
        ? {
            plugin: { new: verdict.plugin },
            ...(verdict.reason ? { reason: { new: verdict.reason } } : {}),
          }
        : {}),
    },
  });
  if (!event.ok) throw new JobError('handler_error');
  return event.event;
}

export function createPublishScanSweepJob(deps: { readonly publishes: PublishesRepository }) {
  return defineJob({
    name: 'publish-scan-sweep',
    version: 1,
    schedule: { everySeconds: 300 },
    validate(input: unknown) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
        throw new JobError('invalid_payload');
      return {};
    },
    async handler(_input, job) {
      if (!jobLeaseOf(job)) throw new JobError('lease_lost');
      const now = job.ports.clock.now().getTime();
      const before = new Date(now - 600_000).toISOString();
      const bucket = Math.floor(now / 600_000);
      const jobs = job.ports.platform?.jobs;
      if (!jobs) throw new JobError('handler_error');
      const runningBefore = new Date(
        job.ports.clock.now().getTime() - JOB_LEASE_SECONDS * 1000,
      ).toISOString();
      for (let item of await deps.publishes.listScanQueued(job.org, before, runningBefore)) {
        if (job.signal.aborted) return;
        if (item.scanState === 'running') {
          const state = item.scanAttempts >= 3 ? 'failed' : 'queued';
          const result = await deps.publishes.scan(job.org, job.fences!.verifier(), {
            id: item.id,
            expectedRevision: item.revision,
            expectedApprovalState: item.approvalState,
            expectedScanState: 'running',
            now: job.ports.clock.now().toISOString(),
            scanState: state,
            verdicts: [],
            event: scanEvent(job, item, state),
          });
          if (!result.changed || state === 'failed') continue;
          const current = await deps.publishes.get(job.org, item.id);
          if (!current || current.scanState !== 'queued') continue;
          item = current;
        }
        await jobs.enqueue(
          job.org,
          PUBLISH_SCAN_JOB,
          { id: item.id },
          {
            idempotencyKey: `publish-sweep:${item.versionId}:${item.revision}:${bucket}`,
            resourceKey: `publish:${item.versionId}`,
          },
        );
      }
    },
  });
}
