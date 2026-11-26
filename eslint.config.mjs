import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'apps/mobile/**', '**/next-env.d.ts', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  { files: ['**/cli/**', '**/seed/cli.ts', 'packages/services/src/logger.ts', 'packages/contracts/src/openapi-cli.ts'], rules: { 'no-console': 'off' } },
);
