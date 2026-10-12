# Dead-code review — Aretia Finance (2026-10-11)

Method: orphan-file script (a source file whose name is not mentioned by any other tracked file), dependency-usage check, then **manual verification of every candidate** (grep incl. docs/config, Astro/Vite globs, Vercel config).

## Removed (verified; website suite unchanged: 118 files / 1,290 tests, typecheck 0 errors, lint, build 38 pages)
| Item | Evidence |
|---|---|
| `website/src/components/hero/HomeHero.astro` (333 lines) | zero references anywhere; the only `import.meta.glob` loads `legacy/pages/*.html`, not components; `gsap`/`motion` stay (used by other components) |

## Examined and KEPT
| Item | Why |
|---|---|
| `website/legacy/` | **Live.** `src/lib/legacy.ts` loads it (`import.meta.glob('../../legacy/pages/*.html')`) to render apply/details/faq/marketplace/roadmap/stake/verify. Deleting it would break the site |
| `website/src/pages/landing-classic.astro` (410 lines) | unlinked but a reachable public URL `/landing-classic`; removing a public route is a **product decision** — candidate for you to confirm |
| `website/api/swings-quote.ts` | documented, feature-flagged public quote API (`SWINGS_PUBLIC_API`) |
| `[slug].astro`, `category/[category].astro`, `404.astro` | file-based routes (no import needed) |
| `scripts/rebuild-mint/upload-metadata.mjs` | documented operator tool (own usage header, MINT_V2) |
| `@astrojs/check`, `eslint`, `typescript`, `@types/pg`, `astro-eslint-parser` | tooling used through npm scripts / ESLint plugin, not imported |
| `src/scripts/walletTools.ts` | compatibility re-export with 9 importers (ADR-0002) |
