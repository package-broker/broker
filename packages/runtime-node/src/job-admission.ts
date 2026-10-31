import type { OrgContext } from '@package-broker/core/db/port';
import type { RegisteredJob } from '@package-broker/core/kernel/registry';

const admissions = new WeakMap<RegisteredJob, (org: OrgContext) => Promise<boolean>>();

export function bindJobAdmission(
  jobs: readonly RegisteredJob[],
  admit: (org: OrgContext) => Promise<boolean>,
): void {
  for (const job of jobs) {
    if (job.plugin === 'core' && job.definition.name.startsWith('audit-')) continue;
    admissions.set(job, admit);
  }
}

export async function admitJob(job: RegisteredJob, org: OrgContext): Promise<boolean> {
  return (await admissions.get(job)?.(org)) ?? true;
}
