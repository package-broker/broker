import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.pb/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/db-sqlite/src/**', 'packages/runtime-*/src/db/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...rawSqlSelectors],
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
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
      ],
    },
  },
);
