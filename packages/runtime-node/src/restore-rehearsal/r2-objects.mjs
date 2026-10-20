import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [operation, directory, bucket] = process.argv.slice(2);
const endpoint = process.env.PB_REHEARSAL_R2_ENDPOINT;
assert.ok(endpoint && new URL(endpoint).protocol === 'https:');
assert.ok(directory && bucket);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function aws(command, args = []) {
  try {
    return JSON.parse(
      execFileSync(
        'aws',
        [
          's3api',
          command,
          '--endpoint-url',
          endpoint,
          '--bucket',
          bucket,
          '--output',
          'json',
          ...args,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, AWS_PAGER: '' },
        },
      ) || '{}',
    );
  } catch {
    throw new Error('R2 CLI operation failed');
  }
}
const list = () => aws('list-objects-v2').Contents ?? [];
const filename = (key) => join(directory, 'objects', hash(key));
const manifestPath = join(directory, 'r2-inventory.json');
if (operation === 'empty') {
  assert.equal(list().length, 0, 'R2 restore target must be empty');
} else if (operation === 'seed') {
  assert.equal(list().length, 0, 'R2 seed target must be empty');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  for (const entry of manifest.objects) {
    const path = join(directory, 'blobs', entry.storageKey);
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.size);
    assert.equal(hash(bytes), entry.sha256);
    aws('put-object', [
      '--key',
      entry.storageKey,
      '--body',
      path,
      '--content-type',
      entry.mediaType,
    ]);
  }
} else if (operation === 'backup') {
  await mkdir(join(directory, 'objects'), { recursive: true, mode: 0o700 });
  const response = JSON.parse(await readFile(join(directory, 'references.json'), 'utf8'));
  const refs = response.flatMap((part) => part.results ?? []);
  assert.ok(refs.length > 0, 'fixture must have referenced bytes');
  const manifest = [];
  for (const ref of refs) {
    const result = aws('get-object', ['--key', ref.storage_key, filename(ref.storage_key)]);
    const bytes = await readFile(filename(ref.storage_key));
    assert.equal(bytes.length, ref.size_bytes);
    assert.equal(hash(bytes), ref.sha256);
    manifest.push({
      ...ref,
      contentType: result.ContentType ?? ref.media_type,
      metadata: result.Metadata ?? {},
    });
  }
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (operation === 'restore') {
    assert.equal(list().length, 0, 'R2 restore target must be empty');
    for (const entry of manifest) {
      const bytes = await readFile(filename(entry.storage_key));
      assert.equal(bytes.length, entry.size_bytes);
      assert.equal(hash(bytes), entry.sha256);
    }
    for (const entry of manifest)
      aws('put-object', [
        '--key',
        entry.storage_key,
        '--body',
        filename(entry.storage_key),
        '--content-type',
        entry.contentType,
        '--metadata',
        JSON.stringify(entry.metadata),
      ]);
  } else if (operation === 'check') {
    for (const entry of manifest) {
      const destination = join(directory, 'verify-object');
      const metadata = aws('get-object', ['--key', entry.storage_key, destination]);
      const bytes = await readFile(destination);
      assert.equal(bytes.length, entry.size_bytes);
      assert.equal(hash(bytes), entry.sha256);
      assert.equal(metadata.ContentType, entry.contentType);
    }
  } else if (operation === 'corrupt') {
    for (const entry of manifest) {
      const path = join(directory, 'corrupt-object');
      await writeFile(path, new Uint8Array(entry.size_bytes).fill(9), { mode: 0o600 });
      aws('put-object', [
        '--key',
        entry.storage_key,
        '--body',
        path,
        '--content-type',
        entry.contentType,
      ]);
    }
  } else if (operation === 'delete') {
    const expected = new Set(manifest.map((entry) => entry.storage_key));
    for (const object of list()) {
      assert.ok(
        expected.has(object.Key),
        'cleanup refuses objects absent from rehearsal inventory',
      );
      aws('delete-object', ['--key', object.Key]);
    }
  } else throw new Error('expected empty, seed, backup, restore, check, corrupt, or delete');
}
process.stdout.write(`R2 ${operation}: PASS\n`);
