import { isUlid } from '../ids.js';
import { JobError, type JobDefinition } from '../platform/jobs.js';
import { runImportApply, type ImportApplyDeps } from './apply.js';
import {
  runImportRollback,
  type ImportRollbackDeps,
  type ImportRollbackPayload,
} from './rollback.js';
import type { ImportRunJobPayload } from './run-service.js';
import { runImportVerification, type ImportVerificationDeps } from './verification.js';

function exactUlids<K extends string>(input: unknown, keys: readonly K[]): Record<K, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('invalid payload');
  }
  const record = input as Record<string, unknown>;
  const own = Object.keys(record);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) {
    throw new TypeError('invalid payload');
  }
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string' || !isUlid(value)) throw new TypeError('invalid payload');
    out[key] = value;
  }
  return out;
}

export function importApplyJob(deps: ImportApplyDeps): JobDefinition<ImportRunJobPayload> {
  return {
    name: 'import-apply',
    version: 1,
    validate: (input) => exactUlids(input, ['runId']),
    async handler(payload, context) {
      const { fences } = context;
      if (fences === undefined) throw new JobError('handler_error');
      await runImportApply(deps, context.org, payload, (a, r, e) => fences.delegated(a, r, e));
    },
  };
}

export function importRollbackJob(deps: ImportRollbackDeps): JobDefinition<ImportRollbackPayload> {
  return {
    name: 'import-rollback',
    version: 1,
    validate: (input) => exactUlids(input, ['runId', 'requestedBy']),
    async handler(payload, context) {
      const { fences } = context;
      if (fences === undefined) throw new JobError('handler_error');
      await runImportRollback(deps, context.org, payload, (a, r, e) => fences.delegated(a, r, e));
    },
  };
}

export function importVerificationJob(
  deps: ImportVerificationDeps,
): JobDefinition<ImportRunJobPayload> {
  return {
    name: 'import-verify',
    version: 1,
    validate: (input) => exactUlids(input, ['runId']),
    async handler(payload, context) {
      const { fences } = context;
      if (fences === undefined) throw new JobError('handler_error');
      await runImportVerification(deps, context.org, payload, () => fences.verifier());
    },
  };
}
