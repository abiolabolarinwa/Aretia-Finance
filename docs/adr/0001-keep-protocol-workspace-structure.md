# ADR-0001: Keep the protocol-workspace layout; enforce boundaries instead of restructuring
- Status: accepted (proposed in Stage A, approved by owner for implementation 2026-10-11)
- Date: 2026-10-11
## Context
The repo is a set of independent projects (operator scripts, an Astro site and its API; at the time of this decision also on-chain programs and SDKs, since removed). A generic `apps/packages` monorepo template would add empty packages and force shared tooling on projects with different toolchains.
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

> **Update 2026-10-12:** the on-chain programs and SDKs mentioned above were removed. What remains is operator scripts, the Astro site and its API; the decision (do not restructure, enforce boundaries) still holds.
