import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/^\\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH)\\s/i]',
          message: 'Raw SQL belongs in a db-sqlite repository (ADR-002)',
        },
        {
          selector:
            'TemplateElement[value.raw=/^\\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH)\\s/i]',
          message: 'Raw SQL belongs in a db-sqlite repository (ADR-002)',
        },
      ],
    },
  },
);
