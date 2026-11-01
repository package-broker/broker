import * as z from 'zod';
import { packageKey } from '../catalogue/names.js';

export const NPM_PACKAGE_NAME_CHECK = z.refine<string>((name) => {
  try {
    packageKey(name, { ecosystem: 'npm' });
    return true;
  } catch {
    return false;
  }
}, 'Invalid npm package name');

export const NPM_HOSTNAME_CHECK = z.refine<string>(
  (value) => new TextEncoder().encode(value).length <= 253,
  'Hostname exceeds 253 bytes',
);
