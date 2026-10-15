import { MigrationSourceError, sha256Hex, type MigrationSource } from './source.js';

const INIT_ID = 'core:0001_init';

function assertSequences(sources: readonly MigrationSource[]): void {
  for (const source of sources) {
    if (!Number.isInteger(source.sequence) || source.sequence < 0) {
      throw new MigrationSourceError(
        `${source.id}: sequence must be a finite non-negative integer, got ${source.sequence}`,
      );
    }
  }
}

function assertUnique(sources: readonly MigrationSource[]): void {
  const ids = new Set<string>();
  const positions = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new MigrationSourceError(`${source.id}: duplicate migration id`);
    ids.add(source.id);
    const position = `${source.owner}:${source.sequence}`;
    if (positions.has(position)) {
      throw new MigrationSourceError(
        `${source.id}: duplicate sequence ${source.sequence} for owner "${source.owner}"`,
      );
    }
    positions.add(position);
  }
}

async function assertChecksums(sources: readonly MigrationSource[]): Promise<void> {
  for (const source of sources) {
    if ((await sha256Hex(source.sql)) !== source.checksum) {
      throw new MigrationSourceError(`${source.id}: checksum does not match the sql`);
    }
  }
}

export async function planMigrations(
  sources: readonly MigrationSource[],
  ownerOrder: readonly string[],
): Promise<MigrationSource[]> {
  if (ownerOrder[0] !== 'core') {
    throw new MigrationSourceError('owner order must start with "core"');
  }
  if (ownerOrder.filter((owner) => owner === 'core').length !== 1) {
    throw new MigrationSourceError('owner order must list "core" exactly once');
  }
  const position = new Map<string, number>();
  ownerOrder.forEach((owner, index) => {
    if (position.has(owner))
      throw new MigrationSourceError(`duplicate owner "${owner}" in owner order`);
    position.set(owner, index);
  });
  for (const source of sources) {
    if (!position.has(source.owner)) {
      throw new MigrationSourceError(
        `${source.id}: owner "${source.owner}" is not in the owner order`,
      );
    }
  }
  assertSequences(sources);
  assertUnique(sources);
  await assertChecksums(sources);
  if (!sources.some((source) => source.id === INIT_ID)) {
    throw new MigrationSourceError(`${INIT_ID}: required migration is missing`);
  }

  const planned = [...sources].sort(
    (a, b) =>
      (position.get(a.owner) ?? 0) - (position.get(b.owner) ?? 0) || a.sequence - b.sequence,
  );
  const [head] = planned;
  if (head !== undefined && head.id !== INIT_ID) {
    throw new MigrationSourceError(`${head.id}: sorts before ${INIT_ID}`);
  }
  return planned;
}

export async function assertPlannedSources(sources: readonly MigrationSource[]): Promise<void> {
  const first = sources[0];
  if (first === undefined) throw new MigrationSourceError('migration list is empty');
  if (first.id !== INIT_ID) {
    throw new MigrationSourceError(`${first.id}: first migration must be ${INIT_ID}`);
  }
  assertSequences(sources);
  assertUnique(sources);

  const finished = new Set<string>();
  let previous: MigrationSource | undefined;
  let pluginSeen = false;
  for (const source of sources) {
    if (source.owner !== 'core') pluginSeen = true;
    else if (pluginSeen) {
      throw new MigrationSourceError(
        `${source.id}: core migration listed after a plugin migration`,
      );
    }
    if (previous?.owner === source.owner) {
      if (source.sequence <= previous.sequence) {
        throw new MigrationSourceError(
          `${source.id}: sequence does not increase after ${previous.id}`,
        );
      }
    } else {
      if (finished.has(source.owner)) {
        throw new MigrationSourceError(`${source.id}: owner "${source.owner}" is not contiguous`);
      }
      if (previous !== undefined) finished.add(previous.owner);
    }
    previous = source;
  }
  await assertChecksums(sources);
}
