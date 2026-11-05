import type { OidcRepository } from '../../../db/oidc.js';
import { JobError, type JobDefinition } from '../../../platform/jobs.js';
import { record } from './input.js';

export function createOidcReplayExpiryJob(
  repository: Pick<OidcRepository, 'purge'>,
): JobDefinition<Record<string, never>> {
  return {
    name: 'oidc-replay-expire',
    version: 1,
    schedule: { everySeconds: 3600 },
    validate(input) {
      if (!record(input) || Object.keys(input).length !== 0) throw new JobError('invalid_payload');
      return {};
    },
    async handler(_payload, context) {
      if (context.signal.aborted) return;
      const now = context.ports.clock.now().toISOString();
      for (let chunk = 0; chunk < 50 && !context.signal.aborted; chunk++) {
        if ((await repository.purge(context.org, now)) < 100) break;
      }
    },
  };
}
