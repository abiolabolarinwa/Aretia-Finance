# act-staking

ACT staking program (Aretia Finance, Part VIII Sec. 30 infrastructure). Full design record, tier formula, account layout, and the build log: see [`../../STAKING_DESIGN.md`](../../STAKING_DESIGN.md) at the repo root.

**Compiles clean, is deployed on devnet** at `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`, and **`initialize_config` has been called for real and verified** (see `scripts/init-devnet-config.mjs`). **`stake`/`unstake` have not been called**, **no test suite has run**, and **no independent review** has happened. See STAKING_DESIGN.md's "Build log" and "Still open" sections before assuming more progress than that.

No Anchor CLI required to build (the program crate uses `anchor-lang`/`anchor-spl` as regular dependencies; `cargo-build-sbf`, bundled with the Solana CLI, does the actual SBF compilation). Anchor CLI would still help for `anchor test`'s local-validator orchestration and IDL generation, but isn't installed in this environment.

## Building

```bash
# from program/act-staking/programs/act-staking, with a native Rust toolchain +
# host linker on PATH (see STAKING_DESIGN.md's "Toolchain" section for how that
# was set up on Windows without WSL) and cargo-build-sbf (bundled with the
# Solana CLI) available:
cargo build-sbf
# -> target/deploy/act_staking.so
```

The program id is already generated and wired in (`Anchor.toml`, `declare_id!()` in `src/lib.rs`) — `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`. Its keypair (`target/deploy/act_staking-keypair.json`) is gitignored and has never been committed; treat it as sensitive since it can sign upgrade-authority transactions once anything is deployed with it.

## Deployed on devnet

```
Program Id: DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH
Owner: BPFLoaderUpgradeab1e11111111111111111111111
```

Upgrade authority has been transferred off the throwaway deployer key onto a dedicated devnet keypair (`devnet-upgrade-authority-keypair.json`, gitignored, never committed) -- still a single key, not the treasury multisig or a devnet-equivalent multisig, which is what mainnet will eventually need. Confirmed via `solana program show`: `Authority: 36mcKLqe2dah5erGo1wH1C6FzyVKAfJpNwoxRKZA5UEj`.

## Exercising the instructions

`scripts/init-devnet-config.mjs` calls `initialize_config` against the live devnet deployment: creates a throwaway Token-2022 test mint (not real ACT), derives the PDAs, hand-builds the instruction (no Anchor CLI/IDL in this environment), sends it, and reads back every field of the resulting `StakeConfig` account to confirm it matches exactly what was sent. Run it with `node scripts/init-devnet-config.mjs` (needs `npm install` first; the deployer keypair path is hardcoded near the top of the script). All nine checks pass as of the last run.

`stake` and `unstake`, the instructions that actually move tokens and do the balance-delta/weighted-age-blending math, have not been called by anything yet. That's the next real test, and the higher-value one -- `initialize_config` just writes a config struct; `stake`/`unstake` are where a subtle bug in this program would actually show up.

Do not deploy to mainnet, or point this at any real ACT, before: `stake`/`unstake` are exercised the same way, a real test suite runs clean against this devnet deployment, and someone other than the person who wrote it has reviewed the program. This is the protocol's first custom on-chain program — see STAKING_DESIGN.md for why that raises the bar relative to everything else in this repo.
