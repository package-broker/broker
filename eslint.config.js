import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import uiActions from './scripts/eslint-ui-actions.mjs';

const rawSqlSelectors = [
  {
    selector: 'Literal[value=/^\\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH)\\s/i]',
    message: 'Raw SQL belongs in a db-sqlite repository (ADR-002)',
  },
  {
    selector:
      'TemplateElement[value.raw=/^\\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH)\\s/i]',
    message: 'Raw SQL belongs in a db-sqlite repository (ADR-002)',
  },
];

const responseMessageSelectors = [
  'CallExpression[callee.name=/^(errorEnvelope|envelopeResponse|jsonResponse)$/]',
  "CallExpression[callee.object.name='Response'][callee.property.name='json']",
  "NewExpression[callee.name='Response']",
  "CallExpression[callee.object.name='c'][callee.property.name=/^(json|text)$/]",
].map((sink) => {
  const member =
    "[object.type='Identifier']:matches([computed=false][property.name=/^(message|stack)$/], [computed=true][property.value=/^(message|stack)$/])";
  return {
    selector: `${sink} > MemberExpression.arguments${member}, ${sink} > *.arguments MemberExpression${member}`,
    message: 'Response errors must use fixed client-safe messages, never an error message',
  };
});

const uiSelectors = [
  ...rawSqlSelectors,
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is banned in the UI (CSP, no raw HTML injection)',
  },
  {
    selector:
      "Property[key.name='dangerouslySetInnerHTML'], Property[key.value='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is banned in the UI (CSP, no raw HTML injection)',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.pb/**',
      '**/node_modules/**',
      'packages/prebuilt/node/**',
      'packages/prebuilt-cloudflare/cloudflare/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/db-sqlite/src/**', 'packages/runtime-*/src/db/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...rawSqlSelectors, ...responseMessageSelectors],
    },
  },
  {
    files: ['packages/db-sqlite/src/**/*.ts', 'packages/runtime-*/src/db/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...responseMessageSelectors],
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx,js,jsx}'],
    rules: { 'no-restricted-syntax': ['error', ...uiSelectors] },
  },
  {
    files: ['packages/ui/src/pages/**/*.{ts,tsx,js,jsx}'],
    plugins: { 'ui-actions': uiActions },
    rules: {
      'ui-actions/row-actions': [
        'error',
        {
          allowlist: [
            'packages/ui/src/pages/packages.tsx',
            'packages/ui/src/pages/projects.tsx',
            'packages/ui/src/pages/sources.tsx',
            'packages/ui/src/pages/tokens.tsx',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...uiSelectors, ...responseMessageSelectors] },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...[
          'Buffer',
          'process',
          'require',
          'module',
          '__dirname',
          '__filename',
          'global',
          'setImmediate',
        ].map((name) => ({
          name,
          message: 'core runs on Workers; use a port or a web API',
        })),
      ],
    },
  },
);
