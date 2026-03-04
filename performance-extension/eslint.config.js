import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

export default [
  {
    ignores: [
      'dist/**',
      '**/*.json',
      '**/*.md',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '.prettierrc',
      '.prettierrc.*'
    ]
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      'no-console': 'off'
    }
  },
  {
    files: ['**/*.{ts,js}'],
    rules: {
      'max-len': 'off'
    }
  }
];
