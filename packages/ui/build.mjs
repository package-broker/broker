import { cp } from 'node:fs/promises';

await cp(new URL('./public', import.meta.url), new URL('./dist/assets', import.meta.url), {
  recursive: true,
});
