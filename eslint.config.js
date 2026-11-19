import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/.next/**',
    '**/.vitest/**',
  ]),

  {
    name: 'archon/js-configs',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
  },

  {
    name: 'archon/root-ts-configs',
    files: ['*.config.{ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },

  {
    name: 'archon/workspace-ts-strict',
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  eslintConfigPrettier,
]);
