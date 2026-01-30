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
    // Ignore test files (not in tsconfig project service),
    // dist, node_modules, and config files
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.js', '**/test/**'],
  },
  {
    rules: {
      // Allow async without await for interface compatibility
      // (e.g., InMemorySessionStore implements async interface with sync ops)
      '@typescript-eslint/require-await': 'off',
    },
  }
);
