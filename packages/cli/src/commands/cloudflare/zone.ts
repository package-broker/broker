import { CloudflareApi, CloudflareError, object, paginatedList } from './api.js';

export async function resolveZone(api: CloudflareApi, hostname: string): Promise<string> {
  const zoneError = (
    code: 'domain_zone_not_found' | 'domain_zone_ambiguous',
    status: number | null = null,
  ) => {
    const error = new CloudflareError(code, 1, false, 'deploy', status);
    error.message = `Zone lookup for ${hostname}: ${error.message}`;
    return error;
  };
  try {
    if (
      hostname.length > 253 ||
      !hostname.includes('.') ||
      !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      throw new CloudflareError('invalid_input', 2, false, 'deploy');
    const labels = hostname.split('.');
    for (let offset = 0; offset < labels.length - 1; offset++) {
      const candidate = labels.slice(offset).join('.');
      const zones = await api.listZones(candidate);
      const matches = zones
        .filter((zone) => zone.name === candidate)
        .map((zone) => ({ zone, accountId: object(zone.account).id }))
        .filter(({ zone, accountId }) => zone.status === 'active' || accountId === api.accountId);
      const active = matches.filter(({ zone }) => zone.status === 'active');
      if (active.length > 1) throw zoneError('domain_zone_ambiguous');
      if (matches.length === 0) continue;
      if (
        active.length !== 1 ||
        matches.some(
          ({ zone, accountId }) => zone.status !== 'active' && accountId === api.accountId,
        )
      )
        throw zoneError('domain_zone_not_found');
      const { zone, accountId } = active[0]!;
      if (
        accountId !== api.accountId ||
        typeof zone.id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(zone.id)
      )
        throw zoneError('domain_zone_not_found');
      const zoneId = zone.id;
      for (let intermediate = 0; intermediate < offset; intermediate++) {
        const name = labels.slice(intermediate).join('.');
        let records: Record<string, unknown>[];
        try {
          records = await paginatedList(
            `/dns_records?type=NS&name=${encodeURIComponent(name)}`,
            (path) => api.requestZone(zoneId, path),
            undefined,
            () => {
              throw new CloudflareError('provider_failure', 1, false, 'deploy');
            },
          );
        } catch (error) {
          if (error instanceof CloudflareError && error.status === 403) {
            const denied = zoneError('domain_zone_not_found', error.status);
            denied.message += ' Delegation checks require DNS Read, which DNS Edit covers.';
            throw denied;
          }
          throw error;
        }
        if (records.length > 0) {
          const error = zoneError('domain_zone_not_found');
          error.message += ` The hostname is delegated away from zone ${candidate}.`;
          throw error;
        }
      }
      return zoneId;
    }
    throw zoneError('domain_zone_not_found');
  } catch (error) {
    if (!(error instanceof CloudflareError)) throw error;
    if (error.code === 'permission_denied' && error.status === 403)
      throw zoneError('domain_zone_not_found', error.status);
    if (error.stage === 'deploy') throw error;
    const staged = new CloudflareError(
      error.code,
      error.exitCode,
      error.retryable,
      'deploy',
      error.status,
      error.check,
      error.providerCode,
      error.source,
      error.fields,
    );
    staged.message = error.message;
    throw staged;
  }
}
