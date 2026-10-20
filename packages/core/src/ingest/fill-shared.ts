import type { UpstreamForm } from '../db/upstream-state.js';
import type { SourceType } from '../sources/config.js';
import { UpstreamError } from '../sources/policy-fetch.js';
import type { DescribeOptions, DocumentValidators } from '../sources/provider.js';
import { continuationOptions } from './apply-description.js';
import { ComposerV1PackageError } from './composer/v1-package.js';
import { ComposerV2Error } from './composer/v2-package.js';
import { NpmPackumentError } from './npm/packument.js';
import type { IngestSessionHandle } from './session.js';
import { SnapshotCorruptError } from './snapshot.js';
import { assertHeaderValue, parsePendingValidators, type PendingValidators } from './validators.js';

export function upstreamForm(type: SourceType, form?: Exclude<UpstreamForm, 'composer-p2-dev'>) {
  return (
    form ?? (type === 'npmjs_proxy' || type === 'npm_registry' ? 'npm-packument' : 'composer-p2')
  );
}

export function safeValidator(value: string | undefined): string | null {
  try {
    assertHeaderValue('validator', value ?? null);
    return value ?? null;
  } catch {
    return null;
  }
}

export function isUpstreamFailure(error: unknown): boolean {
  return (
    error instanceof UpstreamError ||
    error instanceof ComposerV2Error ||
    error instanceof ComposerV1PackageError
  );
}

export function isSnapshotGone(error: unknown): boolean {
  return (
    error instanceof SnapshotCorruptError ||
    (error instanceof NpmPackumentError && error.code === 'snapshot_gone')
  );
}

export function describeOptions(
  session: IngestSessionHandle,
  published: DocumentValidators,
): DescribeOptions {
  const options = continuationOptions(session, published);
  if (options.snapshot?.stagedBlob === undefined || session.pendingValidators === null)
    return options;
  const validators = parsePendingValidators(session.pendingValidators)['npm-packument'];
  if (validators === undefined) return options;
  const snapshot = {
    ...options.snapshot,
    validators: {
      ...(validators.etag === null ? {} : { etag: validators.etag }),
      ...(validators.lastModified === null ? {} : { lastModified: validators.lastModified }),
    },
  };
  return { snapshot };
}

export function pendingValidators(
  validators: DocumentValidators,
  form: UpstreamForm,
): PendingValidators {
  const entries =
    form === 'composer-p2'
      ? ([
          ['composer-p2', validators['composer-p2']],
          ['composer-p2-dev', validators['composer-p2-dev']],
        ] as const)
      : ([[form, validators[form === 'npm-packument' ? 'npm-full' : 'composer-p2']]] as const);
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      {
        etag: safeValidator(value?.etag),
        lastModified: safeValidator(value?.lastModified),
        contentSha256: null,
      },
    ]),
  );
}
