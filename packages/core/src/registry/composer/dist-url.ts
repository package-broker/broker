import { isUlid } from '../../ids.js';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import { packageKey } from '../../catalogue/names.js';
import type { DistType } from '../../db/catalogue.js';

/** tgz and null dist types have no Composer dist URL; the renderer omits the dist for them. */
export type ComposerDistType = Extract<DistType, 'zip' | 'tar'>;

export interface ComposerDistRef {
  project: string;
  vendor: string;
  package: string;
  key: string;
  versionId: string;
  revision: number;
  type: ComposerDistType;
}

export interface ComposerDistInput {
  project: string;
  key: string;
  versionId: string;
  revision: number;
  type: ComposerDistType;
}

const MAX_REVISION = 2 ** 31 - 1;
const REVISION = /^[1-9][0-9]{0,9}$/;
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const FILE = /^(?<versionId>[^.]+)\.(?<revision>[^.]+)\.(?<type>zip|tar)$/;

function isDistType(value: string): value is ComposerDistType {
  return value === 'zip' || value === 'tar';
}

function isRevision(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_REVISION;
}

function canonicalName(name: string): string | null {
  try {
    return packageKey(name, { ecosystem: 'composer' }) === name ? name : null;
  } catch {
    return null;
  }
}

export function composerDistPath(input: ComposerDistInput): string {
  if (!PROJECT_SLUG_PATTERN.test(input.project)) {
    throw new TypeError('invalid project slug');
  }
  if (!isUlid(input.versionId)) {
    throw new TypeError('invalid version id');
  }
  if (!isRevision(input.revision)) {
    throw new TypeError('invalid revision');
  }
  if (!isDistType(input.type)) {
    throw new TypeError('invalid dist type');
  }
  const name = canonicalName(input.key);
  if (name === null) {
    throw new TypeError('invalid package key');
  }
  return `/${input.project}/dist/${name}/${input.versionId}.${input.revision}.${input.type}`;
}

export function parseComposerDistPath(path: string): ComposerDistRef | null {
  const parts = path.split('/');
  const [first, project, literal, vendor, pkg, file] = parts;
  if (
    parts.length !== 6 ||
    first !== '' ||
    literal !== 'dist' ||
    project === undefined ||
    vendor === undefined ||
    pkg === undefined ||
    file === undefined
  ) {
    return null;
  }
  const key = `${vendor}/${pkg}`;
  if (
    !PROJECT_SLUG_PATTERN.test(project) ||
    !SEGMENT.test(vendor) ||
    !SEGMENT.test(pkg) ||
    canonicalName(key) === null
  ) {
    return null;
  }
  const groups = FILE.exec(file)?.groups;
  const versionId = groups?.versionId;
  const revisionText = groups?.revision;
  const type = groups?.type;
  if (
    versionId === undefined ||
    revisionText === undefined ||
    type === undefined ||
    !isUlid(versionId) ||
    !REVISION.test(revisionText) ||
    !isDistType(type)
  ) {
    return null;
  }
  const revision = Number(revisionText);
  if (!isRevision(revision)) {
    return null;
  }
  return { project, vendor, package: pkg, key, versionId, revision, type };
}
