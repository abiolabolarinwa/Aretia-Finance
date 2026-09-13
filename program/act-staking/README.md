# act-staking

ACT staking program (Aretia Finance, Part VIII Sec. 30 infrastructure). Full design record, tier formula, account layout, and the build log: see [`../../STAKING_DESIGN.md`](../../STAKING_DESIGN.md) at the repo root.

**Compiles clean, is deployed on devnet** at `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`, and **`initialize_config`, `stake`, and `unstake`'s early-withdrawal rejection have all been called for real and verified** (see `scripts/init-devnet-config.mjs` and `scripts/stake-unstake-devnet-test.mjs`, 13/13 checks passing). **`unstake`'s success path has not been tested** (needs a matured lock; shortest is 30 real days and a local-validator clock-warp attempt is currently blocked, see below), **no full test suite has run**, and **no independent review** has happened. See STAKING_DESIGN.md's "Build log" and "Still open" sections before assuming more progress than that.

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

- `scripts/init-devnet-config.mjs` — calls `initialize_config` against the live devnet deployment: creates a throwaway Token-2022 test mint (not real ACT), derives the PDAs, hand-builds the instruction (no Anchor CLI/IDL in this environment), sends it, reads back every field of the resulting `StakeConfig` account. All nine checks pass.
- `scripts/stake-unstake-devnet-test.mjs` — calls `stake` (fresh position + a top-up, checking the weighted-average age blend) and `unstake` (confirming it correctly **rejects** an early withdrawal with `StillLocked`), against the same config the script above set up. 13/13 checks pass. **Does not** test `unstake`'s success path -- see "Local-validator attempt" below.
- `scripts/fix-tier-thresholds-devnet.mjs` — a real fix, not a demo: `stake-unstake-devnet-test.mjs` caught the tier thresholds being stored unscaled (see STAKING_DESIGN.md's tier table), and this script corrects them on-chain via `update_tier_config`.

Run any of them with `node scripts/<name>.mjs` (needs `npm install` first; the deployer keypair path is hardcoded near the top of each script).

### Local-validator attempt (root cause confirmed, deferred by decision)

To test `unstake`'s success path without waiting 30 real days, `programs/act-staking/src/lib.rs` has a `test-fast-clock` cargo feature that shrinks a "day" to 2 seconds -- build it separately (`cargo build-sbf --features test-fast-clock --sbf-out-dir target/deploy-test`) and it never touches the real devnet/mainnet binary. Loading that build into `solana-test-validator` failed identically on every attempt -- `Access is denied` unpacking the genesis archive -- regardless of ledger path, elevation (verified genuinely-elevated Administrator PowerShell, same failure), or Windows Defender's real-time protection (disabled entirely, same failure -- Defender is ruled out, not just unproven). Turned out to be a documented upstream issue: native-Windows `solana-test-validator` has a real history of exactly this genesis-unpacking failure ([anza-xyz/agave#24](https://github.com/anza-xyz/agave/issues/24), [solana-labs/solana#23666](https://github.com/solana-labs/solana/issues/23666)), and the ecosystem's own fix is WSL or Linux, not native Windows -- which converges on the same firmware-virtualization blocker documented under "Toolchain" above. **Decided to proceed with devnet-only coverage for now**; the feature and build path stay in the repo for whenever WSL (or another Linux/Mac environment) is available.

Do not deploy to mainnet, or point this at any real ACT, before: `unstake`'s success path is exercised, a real test suite runs clean against this devnet deployment, and someone other than the person who wrote it has reviewed the program. This is the protocol's first custom on-chain program — see STAKING_DESIGN.md for why that raises the bar relative to everything else in this repo.
