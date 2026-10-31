import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function prebuiltAuditProblems(directory, target) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'generated/manifest.json'), 'utf8'));
  } catch {
    return ['prebuilt audit manifest is missing or invalid'];
  }
  const audit = manifest?.audit;
  const problems = [];
  if (
    audit?.policy !== 'availability' ||
    audit?.acceptNoDurableAudit !== false ||
    audit?.maxJournalBytes !== (target === 'cloudflare' ? 4 * 1024 ** 3 : null)
  )
    problems.push(
      'prebuilt audit policy, acceptance or journal budget differs from release config',
    );
  if (audit?.trail?.plugin !== 'audit-trail' || audit?.trail?.toggleEnv !== 'PB_AUDIT_TRAIL')
    problems.push('prebuilt audit trail must declare its runtime toggle');
  for (const kind of ['trail', 'otlp', 'webhook']) {
    const id = kind === 'trail' ? 'audit-trail' : `audit-${kind}-${kind}`;
    if (
      !Array.isArray(manifest?.plugins) ||
      !manifest.plugins.some(
        (plugin) => plugin?.id === id && plugin.package === `@package-broker/plugin-audit-${kind}`,
      )
    )
      problems.push(`prebuilt audit plugin is missing: ${kind}`);
    if (kind === 'trail') continue;
    const sink = Array.isArray(audit?.sinks)
      ? audit.sinks.find((sink) => sink?.id === kind)
      : undefined;
    const destination = sink?.destination;
    if (
      sink?.plugin !== id ||
      sink?.kind !== kind ||
      sink?.activation !== 'env' ||
      sink?.custody !== 'delivery' ||
      !Array.isArray(sink?.envNames) ||
      sink.envNames.length !== 0 ||
      (kind === 'otlp'
        ? destination?.protocol !== 'otlp-http-json' ||
          destination.endpointEnv !== undefined ||
          destination.headersEnv !== undefined
        : destination?.protocol !== 'https-json' ||
          destination.urlEnv !== 'PB_AUDIT_WEBHOOK_URL' ||
          destination.headersEnv !== 'PB_AUDIT_WEBHOOK_HEADERS')
    )
      problems.push(`prebuilt audit sink must use the declared environment: ${kind}`);
  }
  if (!Array.isArray(audit?.sinks) || audit.sinks.length !== 2)
    problems.push('prebuilt audit config must contain both release sinks');
  return problems;
}
