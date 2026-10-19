import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  manifest: {} as {
    plugins: [];
    platformPorts: null;
    observability?: { trustInboundTraceparent: boolean };
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
