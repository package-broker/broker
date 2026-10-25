import { buildBundles } from './local.js';

export default async function setup(): Promise<void> {
  await buildBundles();
}
