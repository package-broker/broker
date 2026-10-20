import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  manifest: {} as {
    plugins: [];
    platformPorts: null;
    observability?: { trustInboundTraceparent: boolean };
    registry?: { timers: { metadataTtlSeconds: number } };
  },
  createWorker: vi.fn(() => ({ fetch: vi.fn() })),
}));
vi.mock('#pb-manifest', () => ({
  get plugins() {
    return state.manifest.plugins;
  },
  get platformPorts() {
    return state.manifest.platformPorts;
  },
  get observability() {
    return state.manifest.observability;
  },
  get registry() {
    return state.manifest.registry;
  },
}));
vi.mock('./index.js', () => ({ createWorker: state.createWorker }));

afterEach(() => {
  vi.resetModules();
  state.createWorker.mockClear();
});

describe('Worker entry observability', () => {
  it.each([true, false, undefined])(
    'passes the configured flag %s to createWorker',
    async (flag) => {
      const observability = flag === undefined ? undefined : { trustInboundTraceparent: flag };
      state.manifest = {
        plugins: [],
        platformPorts: null,
        ...(observability === undefined ? {} : { observability }),
      };
      await import('./entry.js');
      expect(state.createWorker).toHaveBeenCalledExactlyOnceWith([], {
        platformPorts: null,
        observability,
      });
    },
  );
});

describe('Worker entry registry', () => {
  it('forwards registry', async () => {
    const registry = { timers: { metadataTtlSeconds: 120 } };
    state.manifest = { plugins: [], platformPorts: null, registry };
    await import('./entry.js');
    const options = (state.createWorker.mock.calls[0] as unknown[] | undefined)?.[1] as
      { registry?: unknown } | undefined;
    expect(options?.registry).toBe(registry);
  });

  it('omits registry when the manifest has none', async () => {
    state.manifest = { plugins: [], platformPorts: null };
    await import('./entry.js');
    const options = (state.createWorker.mock.calls[0] as unknown[] | undefined)?.[1];
    expect(options).not.toHaveProperty('registry');
  });
});
