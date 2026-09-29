import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import globals from 'globals';

export default [
  // public/ holds the pre-redesign static pages, served as-is; legacy/ is
  // reference material only. Neither is part of the Astro source.
  { ignores: ['dist/', '.astro/', 'node_modules/', 'public/', 'legacy/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  { languageOptions: { globals: { ...globals.browser } } },
];
