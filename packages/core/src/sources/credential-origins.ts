import type { SourceRecord } from '../db/source.js';
import { GITHUB_API, GITHUB_CODELOAD } from './github-origins.js';
import {
  parseSourceConfig,
  type ParseSourceConfigOptions,
  type SourceConfig,
  type SourceType,
} from './config.js';

export function sourceCredentialRequired(source: {
  readonly type: SourceType;
  readonly config: SourceConfig;
}): boolean {
  return (
    source.type !== 'packagist_proxy' ||
    ('githubToken' in source.config && source.config.githubToken === true)
  );
}

export function sourceCredentialOrigins(
  record: SourceRecord,
  { runtime, policy }: Pick<ParseSourceConfigOptions, 'runtime' | 'policy'>,
): readonly string[] | null {
  if (record.type === 'vcs') {
    const parsed = parseSourceConfig(record.type, record.ecosystem, record.url, record.configJson, {
      runtime,
      policy,
      hasCredential: record.credentialId !== null,
    });
    if (!parsed.ok || !('provider' in parsed.config)) return null;
    switch (parsed.config.provider) {
      case 'github':
        return [GITHUB_API];
      case 'git':
        return [new URL(parsed.config.repository).origin];
      case 'ssh':
        return [];
    }
  }
  if (record.type === 'packagist_proxy') {
    const parsed = parseSourceConfig(record.type, record.ecosystem, record.url, record.configJson, {
      runtime,
      policy,
      hasCredential: record.credentialId !== null,
    });
    return parsed.ok && sourceCredentialRequired({ type: record.type, config: parsed.config })
      ? [GITHUB_API, GITHUB_CODELOAD]
      : null;
  }
  if (
    runtime === 'cloudflare' &&
    record.type !== 'npm_registry' &&
    record.type !== 'composer_repository'
  )
    return null;
  if (record.type === 'composer_repository') {
    const parsed = parseSourceConfig(record.type, record.ecosystem, record.url, record.configJson, {
      runtime,
      policy,
      hasCredential: record.credentialId !== null,
    });
    if (!parsed.ok || !('distHosts' in parsed.config) || record.url === null) return null;
    return [
      new URL(record.url).origin,
      ...parsed.config.distHosts.map((host) => `https://${host}`),
    ];
  }
  return record.url === null || !URL.canParse(record.url) ? null : [new URL(record.url).origin];
}
