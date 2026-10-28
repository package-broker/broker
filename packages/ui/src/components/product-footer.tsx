import { createElement, type ReactElement } from 'react';
import { renderProductFooter } from './product-footer-content.js';

export function ProductFooter() {
  return renderProductFooter<ReactElement>((tag, attributes, ...children) =>
    createElement(tag, attributes, ...children),
  );
}
