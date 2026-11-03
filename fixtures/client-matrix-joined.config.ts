import { defineConfig } from '@package-broker/core/config';
import github from '@package-broker/plugin-github';
import scanner from './client-matrix-scanner.mjs';
import base from './client-matrix.config.js';

export default defineConfig({
  ...base,
  plugins: [github(), scanner()],
});
