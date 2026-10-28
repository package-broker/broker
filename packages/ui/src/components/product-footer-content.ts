declare const __UI_VERSION__: string;

export const productFooter = {
  brand: 'PACKAGE.broker',
  description: 'open-source package registry broker',
  version: typeof __UI_VERSION__ === 'undefined' ? 'development' : __UI_VERSION__,
  links: [
    { label: 'AGPL-3.0', href: 'https://github.com/package-broker/broker/blob/main/LICENSE' },
    { label: 'Source code', href: 'https://github.com/package-broker/broker' },
    { label: 'Documentation', href: 'https://package.broker/docs/' },
  ],
} as const;

type FooterTag = 'footer' | 'span' | 'strong' | 'a';
type FooterRenderer<T> = (
  tag: FooterTag,
  attributes: Readonly<Record<string, string>>,
  ...children: (T | string)[]
) => T;

// Setup uses native DOM rendering; keep its markup identical without shipping React there.
export function renderProductFooter<T>(element: FooterRenderer<T>): T {
  return element(
    'footer',
    { className: 'product-footer' },
    element(
      'span',
      {},
      element('strong', {}, productFooter.brand),
      ` ${productFooter.description}`,
    ),
    element('span', {}, `Version ${productFooter.version}`),
    ...productFooter.links.map(({ label, href }) =>
      element(
        'a',
        {
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': `${label} (opens externally in a new tab)`,
        },
        label,
      ),
    ),
  );
}

export function createProductFooter(): HTMLElement {
  return renderProductFooter<HTMLElement>((tag, attributes, ...children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name === 'className' ? 'class' : name, value);
    }
    node.append(...children);
    return node;
  });
}
