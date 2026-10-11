# Contributing

This repository is a protocol workspace of independent projects (see `docs/architecture/OVERVIEW.md`). Each project keeps its own toolchain and lockfile.

## Toolchain
- Node **24** (see `.nvmrc`) with the npm that ships with it (npm 11). Lockfiles were written by npm 11; npm 10 reports some as out of sync even though CI installs them fine.
- `website/`: `npm ci && npm test && npm run typecheck && npm run typecheck:api && npm run lint && npm run build`
- `program/*`: Anchor 0.30.1. Do not build or deploy for mainnet from a development machine without the release procedure in `docs/audit/RELEASE_VERIFICATION.md`.

## Rules
1. **Never commit secrets**, keypairs, seed phrases or real `.env` files. Use placeholders in `.env.example`.
2. **No mainnet operation, deployment or real-funds transaction** as part of a code change. Operator tooling is run by authorised humans per `docs/security/OPERATOR_RUNBOOK.md`.
3. **Do not weaken tests** to get green. Do not add blanket lint/compiler suppressions; a justified single-line exception needs a comment saying why.
4. **Structural changes and behaviour changes go in separate PRs.** Moving code must keep public exports working (compatibility re-export) and ship with a characterization test written before the move.
5. Respect the dependency direction: `website/src/swings/**` must not import `src/scripts/**` or `src/pages/**` (ESLint warns; known exceptions in `docs/architecture/BOUNDARY_EXCEPTIONS.md`).
6. Validate external data (API input, provider responses, env) at the boundary; do not rely on TypeScript types for runtime safety.
7. Never log secrets or full signed transactions.

## Naming
Files `camelCase.ts` (existing convention in `src/swings`, `src/scripts`), `PascalCase.astro` components, types/interfaces `PascalCase`, constants `UPPER_SNAKE_CASE`, env vars `UPPER_SNAKE_CASE` (public browser vars prefixed `PUBLIC_`). Test files `*.test.ts`; tests that need the network are `*.live.ts` and excluded from the default suite.

## Commits & changelog
Imperative, scoped subject (`area: change`). User-visible or security-relevant changes get a line in `CHANGELOG.md`.

## Review
Paths in `.github/CODEOWNERS` require a code-owner review. Security-sensitive changes (programs, authorities, fees, signing, treasury, CI secrets) are never merged on green CI alone.

## Recommended branch protection for `main`
Require PR, ≥1 approval from code owners (≥2 once there is a second maintainer), required checks `website-ci` and `projects-ci`, up-to-date branch, no force-push, signed commits if feasible, restrict who can push.
