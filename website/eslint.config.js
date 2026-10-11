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
  // Architecture boundary (docs/architecture/PROPOSAL.md): the Swings library must not depend on the UI-script or
  // page layers. Report-only ('warn') while the known violations in docs/architecture/BOUNDARY_EXCEPTIONS.md are
  // being removed; promote to 'error' once that list is empty.
  {
    files: ['src/swings/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.live.ts'],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            { group: ['**/scripts/*', '**/scripts/**'], message: 'src/swings must not import from src/scripts (UI layer).' },
            { group: ['**/pages/**'], message: 'src/swings must not import from src/pages.' },
          ],
        },
      ],
    },
  },
];
