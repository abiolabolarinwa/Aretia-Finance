# Changelog

Format: Keep a Changelog. Only user-visible, security-relevant or build-relevant changes.

## Unreleased
### Removed — presale (cancelled)
- `program/act-presale`, `sdk/act-presale` (incl. the `@aretiafinance/act-presale-sdk` source), `sdk/idl/act_presale.json`, the presale on-chain test suite and `PRESALE_DESIGN.md`. Findings F-15/F-16/F-20 are withdrawn as not applicable. Last commit containing the presale: `1cfedff`.
- `website/legacy/home.html`: an unreferenced old home page (the loader only reads `legacy/pages/`) containing the presale countdown/golden-badge UI. Site build and tests unchanged.
### Moved
- AMM transfer-fee compatibility proofs (Raydium/Orca/Meteora), real-ACT mainnet simulations, devnet test-token setup + JSON and `inspect-fee` → `scripts/devnet-amm` (own manifest, 9 dependencies).
### Removed (dead code, verified unreferenced)
- `website/src/components/hero/HomeHero.astro` (333 lines): imported nowhere, not loaded by any glob. Build output, tests and typecheck unchanged.
- `program/act-staking/scripts/set-config-authority-devnet.mjs`: one-off devnet migration for the removed `set_config_authority` instruction; already guarded to exit and superseded by the two-step handoff.
### Added
- `program/svm-tests`: 33 on-chain LiteSVM tests for act-presale and act-staking; `programs-ci` `onchain` job.
### Changed — F-20 (program source, NOT deployed)
- act-presale: `buy` and `buy_with_sol` reject a purchase unless the funded ACT reserve can pay out `gross_up(total ACT sold) + margin` (new error `InsufficientActReserve`). **Breaking:** both instructions take the ACT mint as one extra trailing account; `sdk/act-presale` `ixBuy`/`ixBuyWithSol` gained a required `actMint` argument; IDL updated. The reserve must be funded before sales; five devnet exercise scripts carry a banner that they predate this.
### Changed (program source — NOT deployed; requires SBF build, on-chain tests and owner review first)
- act-presale: `finalize` can be called by anyone once the sale window has ended (F-15); note this also means TGE/vesting start can be triggered by anyone from `end_ts`. `buy_with_sol` rejects a Pyth price whose confidence interval exceeds 1% of the price (F-16).
- act-presale, act-staking: `set_config_authority` removed; replaced by two-step `propose_config_authority` / `accept_config_authority` / `cancel_config_authority` (F-17). **Breaking** for SDK/IDL consumers; `sdk/*` and `sdk/idl/*` updated (IDLs hand-patched).
- Program `Cargo.lock` files are now tracked (verified-compiling resolution with a single anchor-lang 0.30.1).
### Changed
- Swings: Solana primitives (`SWAP_FEE_WALLET`, `KNOWN_TOKENS`, `isSolanaAddress`, `ataAddress`, `TOKEN_PROGRAM_ID`, …) moved from `src/scripts/walletTools.ts` to `src/swings/core/solanaTools.ts`; the old path re-exports them. No value or behaviour change; pinned by `solanaTools.test.ts`.
### Security
- `mainnet/gen-deployer.sh` now refuses to overwrite an existing deployer key and creates new keys with `umask 077`.
- `convert-phantom-key.mjs` writes the keypair file with mode 0600.
- CI: `npm audit` for the website is now blocking at `high`; added `projects-ci` for SDKs/scripts/program test harnesses; added CODEOWNERS, SECURITY.md, PR template, dependabot.
