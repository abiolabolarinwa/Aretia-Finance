# Test Evidence — Aretia Finance (2026-10-11, this branch)

Environment: Node 22.22.0, npm 10.9.4 (npm 11.21.0 via npx where stated), rustc 1.97.0, sandbox without general internet.

| Check | Command (dir) | Result |
|---|---|---|
| Unit tests (after changes) | `npm test` (website, scratch-linked node_modules) | 118 files / **1,290 passed** / 0 failed (baseline 117 / 1,286; +4 new pin tests) |
| Typecheck | `npm run typecheck` | 0 errors, 0 warnings |
| API typecheck | `npm run typecheck:api` | exit 0 |
| Lint | `npm run lint` | exit 0; 3 boundary warnings (accepted) |
| Build | `npm run build` | exit 0, 38 pages |
| Audit gate | `npm audit --omit=dev --audit-level=high` | exit 0 (3 moderate) |
| Install, CI-equivalent | `npx npm@11 ci` (original lockfile) | exit 0, 754 packages |
| SDK builds | `npm ci && npm run build` in `sdk/act-presale`, `sdk/act-staking` | exit 0 |
| Script installs (npm 11) | `npm ci` in `scripts/*` | rebuild-mint OK on npm 11; others OK |
| Staking program compile | `cargo check` (fresh lock) | success, warnings (cfg lints from Anchor macros) |
| Presale program compile | `cargo check` (fresh lock) | **FAILS**: `pyth-solana-receiver-sdk 0.3.2` proc-macro panic (F-03) |
| `gen-deployer.sh` hardening | stub `solana-keygen`, throwaway HOME | 1st run exit 0 mode 600; 2nd run exit 1, file preserved |
| `anchor test`, devnet scripts, `test:live`, gitleaks, CodeQL | — | **not run** (no toolchain/network) |

## Proposed program invariant tests (not written — toolchain for presale not buildable here)
Presale: non-authority `finalize` rejected; (after F-15 decision) anyone can finalize after end; buy outside window rejected; per-buyer min/max; soft-cap-missed → Refunding and each buyer refunds exactly once per currency incl. SOL; claim before TGE rejected; vested amount monotonic and ≤ allocation; `sweep_unsold_act` never leaves vault < owed; stale/zero/wide-conf oracle rejected (F-16); mismatched mint/vault pair rejected.
Staking: stake with unsupported `lock_days` rejected; top-up cannot shorten lock (incl. 29d23h boundary); unstake before `unlock_at` rejected; paused blocks stake but not unstake; `total_staked` equals sum of positions; tier table validation; authority transfer to default key rejected.
