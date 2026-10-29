import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      quotes: ['warn', 'single'],
      indent: ['warn', 2, { SwitchCase: 1 }],
      'linebreak-style': ['warn', 'unix'],
      semi: ['warn', 'always'],
      'comma-dangle': ['warn', 'always-multiline'],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        setTimeout: 'readonly',
      },
    },
  },
);
