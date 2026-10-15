import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@package-broker/db-sqlite/migrations/source';
import { definePlugin } from '@package-broker/core/plugin';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectMigrations, defaultResolvePackageDir } from './migrations-collect.js';

const plugin = (id: string, migrations?: { dir: string }) =>
  definePlugin({
    id,
    package: `fake-plugin-${id}`,
    apiVersion: 2,
    platforms: ['node'],
    ...(migrations ? { migrations } : {}),
  });

describe('collectMigrations', () => {
  let root: string;
  const resolve = (name: string) => path.join(root, name);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pb-collect-'));
    await mkdir(path.join(root, '@package-broker/db-sqlite/migrations'), { recursive: true });
    await writeFile(
      path.join(root, '@package-broker/db-sqlite/migrations/0001_init.sql'),
      'CREATE TABLE t (id TEXT);\n',
    );
    await mkdir(path.join(root, 'fake-plugin-x/migrations'), { recursive: true });
    await writeFile(
      path.join(root, 'fake-plugin-x/migrations/0001_a.sql'),
      'CREATE TABLE x_a (id TEXT);\n',
    );
    await writeFile(path.join(root, 'fake-plugin-x/migrations/notes.txt'), 'ignored');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collects core and plugin migrations in plan order', async () => {
    const plan = await collectMigrations([plugin('x', { dir: 'migrations' })], resolve);
    expect(plan.map((source) => source.id)).toEqual(['core:0001_init', 'x:0001_a']);
  });

  it('adds nothing for a plugin without migrations', async () => {
    const plan = await collectMigrations([plugin('x')], resolve);
    expect(plan.map((source) => source.id)).toEqual(['core:0001_init']);
  });

  it('rejects a migrations dir that leaves the plugin package', async () => {
    await expect(collectMigrations([plugin('x', { dir: '../../etc' })], resolve)).rejects.toThrow(
      /outside/,
    );
  });

  it('rejects an absolute migrations dir', async () => {
    await expect(collectMigrations([plugin('x', { dir: tmpdir() })], resolve)).rejects.toThrow(
      /outside/,
    );
  });

  it('accepts "." and a child directory whose name starts with two dots', async () => {
    await writeFile(
      path.join(root, 'fake-plugin-x/0002_root.sql'),
      'CREATE TABLE x_r (id TEXT);\n',
    );
    const dot = await collectMigrations([plugin('x', { dir: '.' })], resolve);
    expect(dot.map((source) => source.id)).toEqual(['core:0001_init', 'x:0002_root']);
    await mkdir(path.join(root, 'fake-plugin-x/..migrations'), { recursive: true });
    await writeFile(
      path.join(root, 'fake-plugin-x/..migrations/0001_b.sql'),
      'CREATE TABLE x_b (id TEXT);\n',
    );
    const plan = await collectMigrations([plugin('x', { dir: '..migrations' })], resolve);
    expect(plan.map((source) => source.id)).toEqual(['core:0001_init', 'x:0001_b']);
  });

  it('rejects a migrations symlink that points outside the plugin package', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'pb-outside-'));
    try {
      await writeFile(path.join(outside, '0001_evil.sql'), 'CREATE TABLE evil (id TEXT);\n');
      await symlink(outside, path.join(root, 'fake-plugin-x/linked'));
      await expect(collectMigrations([plugin('x', { dir: 'linked' })], resolve)).rejects.toThrow(
        /outside/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('defaultResolvePackageDir', () => {
  it('collects the real core migration with its checksum', async () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const plan = await collectMigrations([], defaultResolvePackageDir(repoRoot));
    const real = await readFile(
      path.join(repoRoot, 'packages/db-sqlite/migrations/0001_init.sql'),
      'utf8',
    );
    expect(plan.map((source) => source.id)).toEqual(['core:0001_init']);
    expect(plan[0]?.checksum).toBe(await sha256Hex(real.replace(/\r\n/g, '\n')));
  });
});
