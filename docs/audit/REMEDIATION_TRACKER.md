# Remediation Tracker — Aretia Finance

Legend: ✅ done on branch + evidence · 🟡 partial · ⬜ not started · 👤 needs owner decision/action. "Done" never means merged or externally reviewed.

| ID | Action | State | Evidence / next step |
|---|---|---|---|
| F-05 | Move Solana primitives to `swings/core` with re-export | ✅ | `solanaTools.test.ts`; full suite green; see MIGRATION_LOG M-02 |
| F-12 | `gen-deployer.sh` no overwrite | ✅ | stub test (see register) |
| F-14 | Keypair file mode 0600 | 🟡 | `node --check` only |
| F-07 | CI audit blocking; projects CI | 🟡 | SHA-pin actions 👤 (needs SHA lookup outside tool scope) |
| F-01 | Document npm 11 / `.nvmrc` | ✅ | `.nvmrc`, CONTRIBUTING |
| F-13 | Confirmation guards on mainnet stage scripts | 👤 | owner to confirm whether superseded |
| F-08 | Triage script-project high advisories | 🟡 triaged | per-project reachability notes in THIRD_PARTY_DEPENDENCIES.md |
| F-06 | ADR: share code between website and extension? | 👤 | ADR-0003 written (proposed); owner decision; fee rate aligned at 0.58% (wallet `6cd03a3`); website now also charges 0.58% on token sales (2026-10-13); on-chain proof for a sale pending |
| F-09 | Import cycle | ✅ | `madge --circular` clean; suite green. `any`/suppression counts still open |
| F-10 | Status labels on design docs | 🟡 | status banner added to `PROTOCOL.md`, `TOKENOMICS.md`; stale cross-references fixed. Public whitepapers deliberately not bannered; mint/treasury records already carry status. |
| F-21 | Simulate or atomically collect the EVM token-sale fee | 🟡 | simulate-before-send implemented, 8 unit tests; needs a testnet or fork test |
| F-22 | Solana token-sale fee: treasury account rent and Token-2022 mints | 🟡 | fee now taken from the output for sales into SOL/USDC/USDT (owner decision 2026-10-14), tested; token-to-token swaps still on the input with disclosure; needs an on-chain canary sale |
| F-23 | Outside routes rejected for sales | 👤 | accept or add a fee-collecting wrapper |
| F-24/F-25 | Zero-fee reporting; naming debt | ⬜ | small, safe to batch |
