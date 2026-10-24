import { defineConfig } from '@package-broker/core/config';
import { definePlugin } from '@package-broker/core/plugin';
import base from './observability-base.config.js';

let release: (() => void) | undefined;
let entered = false;
const held = new Promise<void>((resolve) => {
  release = resolve;
});

const barrier = (): Promise<unknown> =>
  typeof WebSocketPair === 'undefined' ? held : fetch('http://t767-barrier.test/hold');

export default defineConfig({
  ...base,
  plugins: [
    definePlugin({
      id: 'held-batch',
      package: '@package-broker/core',
      apiVersion: 3,
      platforms: ['node', 'cloudflare'],
      register(registry) {
        registry.route({
          method: 'GET',
          path: '/fixture/held/:mode',
          permission: null,
          handler: async (ctx) => {
            const mode = ctx.params['mode'];
            if (mode === 'state') return Response.json({ entered });
            if (mode === 'release') {
              release?.();
              return Response.json({ released: true });
            }
            if (mode === 'slow') {
              entered = true;
              await barrier();
            }
            const error = new Error(
              'T767-secret\nBearer t767-credential\nhttps://user:password@host.test/private\naccount@t767.test',
            );
            Object.defineProperty(error, 'name', {
              get() {
                throw new Error('T767-secret name getter');
              },
            });
            throw error;
          },
        });
      },
    }),
  ],
});
