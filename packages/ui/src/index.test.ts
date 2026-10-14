import { describe, expect, it } from 'vitest';
import { UI_ASSETS_DIR } from './index.js';

describe('ui', () => {
  it('names the assets directory', () => {
    expect(UI_ASSETS_DIR).toBe('assets');
  });
});
