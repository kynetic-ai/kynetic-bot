import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.js'],
  },
  {
    rules: {
      // Allow async without await for interface compatibility
      // (e.g., InMemorySessionStore implements async interface with sync ops)
      '@typescript-eslint/require-await': 'off',
    },
  }
);
