import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu.js';

it('renders a named menu button and keeps closed actions out of the initial document', () => {
  const html = renderToString(
    createElement(
      DropdownMenu,
      { className: 'row-menu' },
      createElement(DropdownMenuTrigger, { 'aria-label': 'More actions for Alpha' }, 'More'),
      createElement(
        DropdownMenuContent,
        null,
        createElement(DropdownMenuItem, null, 'Registered names'),
      ),
    ),
  );
  expect(html).toContain('aria-label="More actions for Alpha"');
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('type="button"');
  expect(html).not.toMatch(/<details|<summary|<style\b|\sstyle=/);
  expect(html).not.toContain('Registered names');
});
