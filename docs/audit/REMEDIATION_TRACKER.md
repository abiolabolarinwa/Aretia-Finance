# Remediation Tracker — Aretia Finance

Legend: ✅ done on branch + evidence · 🟡 partial · ⬜ not started · 👤 needs owner decision/action. "Done" never means merged or externally reviewed.

| ID | Action | State | Evidence / next step |
|---|---|---|---|
| F-05 | Move Solana primitives to `swings/core` with re-export | ✅ | `solanaTools.test.ts`; full suite green; see MIGRATION_LOG M-02 |
| F-12 | `gen-deployer.sh` no overwrite | ✅ | stub test (see register) |
| F-14 | Keypair file mode 0600 | 🟡 | `node --check` only |
| F-07 | CI audit blocking; projects CI | 🟡 | SHA-pin actions 👤 (needs SHA lookup outside tool scope) |
| F-01 | Document npm 11 / `.nvmrc` | ✅ | `.nvmrc`, CONTRIBUTING |
| F-20 | Reserve not enforced against sales | 👤 decision | see FINDINGS_REGISTER; characterization test in place |
| F-03 | Reproducible program builds | 🟡 | lockfiles committed (verified-compiling, not the deployed lock); toolchain pin for SBF/Anchor CLI still 👤 |
| F-15 | Permissionless finalize after end | ✅ on-chain (LiteSVM) | 👤 owner review, devnet run, redeploy plan |
| F-16 | Pyth confidence check | ✅ on-chain (LiteSVM) | 👤 confirm `MAX_PRICE_CONF_BPS` (100 = 1%) |
| F-17 | Two-step authority handoff | ✅ on-chain (LiteSVM), both programs | 👤 regenerate IDLs with the Anchor CLI; staking devnet upgrade (not done); `tests/full-suite.mjs` updated but unrun |
| F-02 | Program invariant tests | ⬜ | see TEST_EVIDENCE.md for list; requires working Anchor/LiteSVM toolchain (not available in this sandbox for presale) |
| F-13 | Confirmation guards on mainnet stage scripts | 👤 | owner to confirm whether superseded |
| F-08 | Triage SDK/script high advisories | ⬜ | per-project reachability notes in THIRD_PARTY_DEPENDENCIES.md |
| F-06 | ADR: share code between website and extension? | 👤 | decision |
| F-09/F-10/F-18/F-19 | low/info | ⬜ | backlog |
