# Test Evidence — Aretia Finance (current state, 2026-10-12, this branch)

Environment: Node 22.22.0, npm 10.9.4 (npm 11.21.0 via npx where stated), sandbox without general internet.
Only results that still describe this repository are listed. Earlier evidence for code that was later removed was deleted from this file on 2026-10-12 and is in git history.

| Check | Command (dir) | Result |
|---|---|---|
| Unit tests | `npm test` (website, scratch-linked node_modules) | 118 files / **1,290 passed** / 0 failed (includes the 4 pin tests for the Solana primitives) |
| Typecheck | `npm run typecheck` (`astro check`) | 0 errors, 0 warnings |
| API typecheck | `npm run typecheck:api` | exit 0 |
| Lint | `npm run lint` | exit 0; 3 boundary warnings (accepted, see `docs/architecture/BOUNDARY_EXCEPTIONS.md`) |
| Build | `npm run build` | exit 0, **37 pages** |
| Audit gate | `npm audit --omit=dev --audit-level=high` | exit 0 (3 moderate) |
| Install, CI-equivalent | `npx npm@11 ci` (website lockfile) | exit 0, 754 packages |
| Script installs (npm 11) | `npm ci` in `scripts/*` | rebuild-mint OK on npm 11; others OK |
| `scripts/devnet-amm` | `npm ci` (npm 11); import smoke; `node --check` | 140 packages installed; all 9 imported packages load; every `.mjs` passes the syntax check; the scripts themselves were **not run** (devnet/network) |
| `gen-deployer.sh` hardening | stub `solana-keygen`, throwaway HOME | 1st run exit 0 mode 600; 2nd run exit 1, file preserved |
| Content edits (HTML pages) | tag-balance comparison against the previous commit | `li`/`ul`/`nav`/`div`/`a`/`p` balances unchanged on every edited page |
| Devnet scripts, `test:live`, gitleaks, CodeQL | — | **not run** (no network / tooling) |
