# ADR-0001: Keep the protocol-workspace layout; enforce boundaries instead of restructuring
- Status: accepted (proposed in Stage A, approved by owner for implementation 2026-10-11)
- Date: 2026-10-11
## Context
The repo is nine independent projects (two Anchor programs, SDKs, operator scripts, an Astro site). A generic `apps/packages` monorepo template would add empty packages and force shared tooling on projects with different toolchains. Anchor paths are referenced by `Anchor.toml`, docs and scripts.
## Decision
Do not move directories. Add per-project CI, a lint-enforced dependency direction inside `website/src`, governance files and an audit pack.
## Alternatives considered
Full monorepo with `packages/domain|application|…` (rejected: churn, no benefit); splitting `website/src/swings` into its own npm package (deferred: revisit after boundary exceptions reach zero and if the extension wants to share it — see F-06).
## Consequences
Low-risk, reversible; each project keeps its own lockfile (nine of them), so dependency governance stays per-project.
## Security implications
No change to on-chain code or signing paths.
## Migration implications
None.

> **Update 2026-10-12:** both Anchor programs and the SDKs were removed (presale and staking cancelled). What remains is operator scripts, the Astro site and its API; the decision (do not restructure, enforce boundaries) still holds.
