import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  harnessAssert as assert,
  runCommand,
  clientCommands,
  prepareClient,
} from './client-matrix.mjs';

export async function runManagement({ broker, origin, client, publisher, name, directory, debug }) {
  const run = (command, args) =>
    runCommand(command, args, publisher.project, publisher.env, { debug });
  const manager = await prepareClient(
    join(directory, 'manage-' + name.replaceAll('/', '-')),
    client,
    `${origin}/alpha/npm/`,
    broker.manageToken,
  );
  const manage = (command, args) =>
    runCommand(command, args, manager.project, manager.env, { debug });
  const native = (args) => manage(client, args);
  const manifestPath = join(publisher.project, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '1.1.0' }));
  const publish = clientCommands(client).publish;
  assert.equal((await run(publish.command, publish.args)).code, 0, 'Second version publish failed');
  const tag = (operation, ...args) =>
    native(
      client === 'yarn'
        ? ['npm', 'tag', operation, ...args]
        : [
            'dist-tag',
            operation === 'remove' ? 'rm' : operation === 'list' ? 'ls' : operation,
            ...args,
          ],
    );
  assert.equal((await tag('add', `${name}@1.1.0`, 'beta')).code, 0, 'Dist-tag add failed');
  const listed = await tag('list', name);
  assert.equal(listed.code, 0, 'Dist-tag list failed');
  assert.ok(/beta/.test(listed.output) && /1\.1\.0/.test(listed.output), 'Missing beta dist-tag');
  assert.equal((await tag('remove', name, 'beta')).code, 0, 'Dist-tag remove failed');
  // npm supplies the deprecate/unpublish protocol; Yarn has native tag commands only.
  const npm = (args) => manage('npm', args);
  assert.equal(
    (await npm(['deprecate', `${name}@<2`, 'matrix-deprecation-warning'])).code,
    0,
    'Deprecate failed',
  );
  const consumer = await prepareClient(
    join(directory, 'warning-' + name.replaceAll('/', '-')),
    'npm',
    `${origin}/alpha/npm/`,
    broker.publishToken,
  );
  await writeFile(
    join(consumer.project, 'package.json'),
    JSON.stringify({ name: 'warning-consumer', private: true, dependencies: { [name]: '1.0.0' } }),
  );
  const installed = await runCommand(
    'npm',
    ['install', '--ignore-scripts', '--no-audit'],
    consumer.project,
    consumer.env,
    { debug },
  );
  assert.equal(installed.code, 0, 'Deprecated install failed');
  assert.ok(
    installed.output.includes('matrix-deprecation-warning'),
    'Install did not show the deprecation warning',
  );
  assert.equal((await npm(['deprecate', `${name}@1`, ''])).code, 0, 'Undeprecate failed');
  await broker.agePublish(name, true);
  assert.ok(
    (await npm(['unpublish', `${name}@1.0.0`, '--force'])).code !== 0,
    'Expired unpublish was accepted',
  );
  await broker.agePublish(name, false);
  assert.equal(
    (await npm(['unpublish', `${name}@1.0.0`, '--force'])).code,
    0,
    'Version unpublish failed',
  );
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.ok(
    (await run(publish.command, publish.args)).code !== 0,
    'Tombstoned version was republished',
  );
  assert.equal(
    (await npm(['unpublish', name, '--force'])).code,
    0,
    'Whole-package unpublish failed',
  );
  assert.ok(
    (await broker.inspectPublish(name)).every((v) => v.status === 'tombstoned'),
    'Unpublish did not retain tombstones',
  );
}
