// eslint.config.mjs
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';

export default defineConfig([
  // 1. Apply general language options (like globals) globally or per file group
  {
    files: ['**/*.{js,mjs,cjs}'], // Apply to all relevant JS files
    languageOptions: {
      ecmaVersion: 'latest', // Good practice to set the ECMAScript version
      globals: {
        ...globals.node, // Use Node.js global variables
        // ... add other globals if needed (e.g., globals.jest for test files)
      },
    },
    // You could add common rules here too if needed
  },

  // 2. Configure source type based on file extension
  {
    files: ['**/*.js', '**/*.cjs'], // CommonJS files
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    files: ['**/*.mjs'], // ES Module files
    languageOptions: {
      sourceType: 'module',
    },
  },

  // 3. Apply recommended ESLint rules (@eslint/js)
  // This implicitly loads the necessary plugin and enables recommended rules.
  // This should come *before* prettierConfig.
  js.configs.recommended,

  // 4. Apply Prettier compatibility config
  // *MUST* be loaded *after* any other config that enables rules (like js.configs.recommended)
  // This disables ESLint formatting rules that conflict with Prettier.
  prettierConfig,

  // 5. Define ignored files/directories
  {
    ignores: [
      'build/', // Ignore build output
      'coverage/', // Ignore coverage reports
      'node_modules/', // Standard ignore
      'test/cpp/', // Ignore C++ test files
      '**/*.map', // Ignore source map files
    ],
  },
]);
