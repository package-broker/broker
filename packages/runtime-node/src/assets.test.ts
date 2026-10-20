import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeAssets } from './assets.js';

vi.mock('node:fs/promises', { spy: true });

let directory: string;
let root: string;
const files = {
  'index.html': { contentType: 'text/html', bytes: 3 },
  'app.js': { contentType: 'text/javascript', bytes: 4 },
};
const manifest = { version: 1, entry: 'index.html', files };
const writeManifest = (body: unknown) =>
  fs.writeFile(join(root, 'manifest.json'), JSON.stringify(body));

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 't535-'));
  root = join(directory, 'assets');
  await fs.mkdir(root);
  await writeManifest(manifest);
  await fs.writeFile(join(root, 'index.html'), Uint8Array.of(0, 128, 255));
  await fs.writeFile(join(root, 'app.js'), 'code');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('Node assets', () => {
  describe('FIFO refusal', () => {
    let fifo: string;

    afterEach(() => {
      // Release a blocked reader when the nonblocking-open guard is mutated away.
      closeSync(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK));
    });

    it.each(['index.html', 'manifest.json'])(
      'refuses FIFO %s promptly',
      async (name) => {
        fifo = join(root, name);
        await fs.unlink(fifo);
        execFileSync('mkfifo', [fifo]);
        if (name === 'manifest.json') {
          await expect(createNodeAssets(root)).rejects.toThrow('UI manifest is invalid');
        } else {
          const assets = await createNodeAssets(root);
          expect(await assets.read(name)).toBeNull();
        }
      },
      2000,
    );
  });

  it('serves fixture bytes and metadata for every manifest entry', async () => {
    const assets = await createNodeAssets(root);
    expect(await assets.manifest()).toEqual(manifest);
    for (const [name, file] of Object.entries(files)) {
      expect(await assets.read(name)).toEqual({
        body: new Uint8Array(await fs.readFile(join(root, name))),
        ...file,
      });
    }
  });

  it('opens read-only without following a symlink swapped after realpath', async () => {
    const assets = await createNodeAssets(root);
    const outside = join(directory, 'outside.html');
    await fs.writeFile(outside, 'out');
    const { realpath } = await vi.importActual<typeof fs>('node:fs/promises');
    const resolvedRoot = await realpath(root);
    vi.spyOn(fs, 'realpath').mockImplementationOnce(async (path) => {
      const resolved = await realpath(path);
      await fs.unlink(resolved);
      await fs.symlink(outside, resolved);
      return resolved;
    });
    vi.mocked(fs.open).mockClear();
    expect(await assets.read('index.html')).toBeNull();
    expect(fs.open).toHaveBeenCalledWith(
      join(resolvedRoot, 'index.html'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  });

  it('checks the opened handle is regular before reading and closes it', async () => {
    const assets = await createNodeAssets(root);
    const handle = await fs.open(root, constants.O_RDONLY);
    vi.spyOn(handle, 'stat').mockResolvedValueOnce(Object.assign(await handle.stat(), { size: 3 }));
    const read = vi.spyOn(handle, 'readFile');
    const close = vi.spyOn(handle, 'close');
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    expect(await assets.read('index.html')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('checks the opened handle size before reading and closes it', async () => {
    const assets = await createNodeAssets(root);
    await fs.writeFile(join(root, 'index.html'), 'long');
    const handle = await fs.open(join(root, 'index.html'), constants.O_RDONLY);
    const read = vi.spyOn(handle, 'readFile');
    const close = vi.spyOn(handle, 'close');
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    expect(await assets.read('index.html')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('reads bytes from the checked handle and closes it', async () => {
    const assets = await createNodeAssets(root);
    const handle = await fs.open(join(root, 'index.html'), constants.O_RDONLY);
    const stat = vi.spyOn(handle, 'stat');
    const read = vi.spyOn(handle, 'readFile');
    const close = vi.spyOn(handle, 'close');
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    vi.mocked(fs.readFile).mockClear();
    expect((await assets.read('index.html'))?.body).toEqual(Uint8Array.of(0, 128, 255));
    expect(stat).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['..', '__proto__', '../secret.txt'])(
    'refuses manifest name %s at startup',
    async (name) => {
      await writeManifest({
        ...manifest,
        files: { ...files, [name]: { contentType: 'text/html', bytes: 3 } },
      });
      await expect(createNodeAssets(root)).rejects.toThrow('UI manifest is invalid');
    },
  );

  it('reports a missing assets directory distinctly from an invalid manifest', async () => {
    await expect(createNodeAssets(join(directory, 'absent'))).rejects.toMatchObject({
      code: 'UI_ASSETS_ABSENT',
    });
    await fs.rm(join(root, 'manifest.json'));
    const invalid = await createNodeAssets(root).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ message: 'UI manifest is invalid' });
    expect(invalid).not.toHaveProperty('code', 'UI_ASSETS_ABSENT');
  });

  it('refuses an unlisted manifest entry at startup', async () => {
    await writeManifest({ ...manifest, entry: 'missing.html' });
    await expect(createNodeAssets(root)).rejects.toThrow('UI manifest is invalid');
  });

  it('returns null for an unlisted name without filesystem calls', async () => {
    const assets = await createNodeAssets(root);
    vi.clearAllMocks();
    expect(await assets.read('missing.html')).toBeNull();
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('refuses an inherited name without filesystem calls', async () => {
    const assets = await createNodeAssets(root);
    vi.clearAllMocks();
    expect(await assets.read('toString')).toBeNull();
    expect(fs.realpath).not.toHaveBeenCalled();
  });

  it('refuses a symlink pointing into a sibling with the root prefix', async () => {
    const sibling = `${root}-outside`;
    await fs.mkdir(sibling);
    await fs.writeFile(join(sibling, 'index.html'), 'out');
    await fs.unlink(join(root, 'index.html'));
    await fs.symlink(join(sibling, 'index.html'), join(root, 'index.html'));
    expect(await (await createNodeAssets(root)).read('index.html')).toBeNull();
  });

  it('refuses a manifest symlink outside the root', async () => {
    await fs.rename(join(root, 'manifest.json'), join(directory, 'manifest.json'));
    await fs.symlink(join(directory, 'manifest.json'), join(root, 'manifest.json'));
    await expect(createNodeAssets(root)).rejects.toThrow('UI manifest is invalid');
  });

  it('refuses a directory listed as a file', async () => {
    await fs.unlink(join(root, 'index.html'));
    await fs.mkdir(join(root, 'index.html'));
    const assets = await createNodeAssets(root);
    vi.clearAllMocks();
    expect(await assets.read('index.html')).toBeNull();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('refuses a missing file', async () => {
    await fs.unlink(join(root, 'index.html'));
    expect(await (await createNodeAssets(root)).read('index.html')).toBeNull();
  });

  it('refuses a length mismatch', async () => {
    await fs.writeFile(join(root, 'index.html'), 'long');
    expect(await (await createNodeAssets(root)).read('index.html')).toBeNull();
  });
});
