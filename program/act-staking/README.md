# act-staking

ACT staking program (Aretia Finance, Part VIII Sec. 30 infrastructure). Full design record, tier formula, account layout, and the build log: see [`../../STAKING_DESIGN.md`](../../STAKING_DESIGN.md) at the repo root.

**Compiles clean, is deployed on devnet** at `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH` (upgraded 14 Sept 2026 to add `set_config_authority` and a lock-shortening fix), and **`initialize_config`, `stake`, `unstake` (both the early-withdrawal rejection and, as of 18 Sept 2026, the success path), and `set_config_authority` have all been called for real and verified** (see `scripts/init-devnet-config.mjs`, `scripts/stake-unstake-devnet-test.mjs`, `scripts/unstake-success-devnet-test.mjs`, and `scripts/set-config-authority-devnet.mjs`; 13/13, 6/6, and 9/9 checks respectively). `StakeConfig.authority` is no longer the throwaway devnet deployer key — it's been migrated to the dedicated `devnet-upgrade-authority-keypair.json`. `unstake`'s success path was proven via a throwaway devnet deployment built with `test-fast-clock` (see "Local-validator attempt" below for why that route, not a local validator) — confirmed it pays out correctly after maturity, with no gross-up on the withdrawal-side fee (documented, deliberate: the staker nets `deposit_amount * 0.965^2`, not `* 0.965`), and that the position account closes with its rent refunded. **The lock-shortening fix has since been exercised live too** (18 Sept 2026, see `scripts/lock-shortening-fix-devnet-test.mjs` below; 9/9 checks). **No full test suite has run**, and **no independent review** has happened. See STAKING_DESIGN.md's "Build log" and "Still open" sections before assuming more progress than that.

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
- `scripts/stake-unstake-devnet-test.mjs` — calls `stake` (fresh position + a top-up, checking the weighted-average age blend) and `unstake` (confirming it correctly **rejects** an early withdrawal with `StillLocked`), against the same config the script above set up. 13/13 checks pass. **Does not** test `unstake`'s success path -- see `unstake-success-devnet-test.mjs` below for that.
- `scripts/unstake-success-devnet-test.mjs` — closes the gap the script above left open. Runs against a **throwaway devnet deployment** (`Dk71i4rN8MmPFc1awfChRZigcso8DwBMLKwSGS5NW7ur`, closed after this test ran) built with the `test-fast-clock` feature, since a real 30-day lock can't be waited out and the local-validator route below is blocked. Stakes, confirms the early-rejection still works, waits for the (fast-clocked) lock to mature, then unstakes for real -- confirming the payout amount, the lack of gross-up on the withdrawal fee, and that the position account closes with its rent refunded. 6/6 checks pass.
- `scripts/fix-tier-thresholds-devnet.mjs` — a real fix, not a demo: `stake-unstake-devnet-test.mjs` caught the tier thresholds being stored unscaled (see STAKING_DESIGN.md's tier table), and this script corrects them on-chain via `update_tier_config`.
- `scripts/lock-shortening-fix-devnet-test.mjs` — exercises the "cannot shorten an existing lock" guard for real, against the primary deployment (no time manipulation needed for this one). Uses a fresh staker keypair (the mint authority's own existing position has too little time left to test a shortening against). Stakes 10 tokens for 90 days, confirms a 30-day top-up is rejected with `CannotShortenLock`, then confirms a 90-day and a 365-day top-up both succeed and extend `unlock_at` correctly. 9/9 checks pass. Leaves a real, still-locked position (12 tokens, 365 days) on the primary devnet deployment for that fresh keypair.

Run any of them with `node scripts/<name>.mjs` (needs `npm install` first; the deployer keypair path is hardcoded near the top of each script).

### Local-validator attempt (root cause confirmed, worked around via a throwaway devnet deployment)

To test `unstake`'s success path without waiting 30 real days, `programs/act-staking/src/lib.rs` has a `test-fast-clock` cargo feature that shrinks a "day" to 2 seconds -- build it separately (`cargo build-sbf --features test-fast-clock --sbf-out-dir target/deploy-test`) and it never touches the real devnet/mainnet binary. Loading that build into `solana-test-validator` failed identically on every attempt -- `Access is denied` unpacking the genesis archive -- regardless of ledger path, elevation (verified genuinely-elevated Administrator PowerShell, same failure), or Windows Defender's real-time protection (disabled entirely, same failure -- Defender is ruled out, not just unproven). Turned out to be a documented upstream issue: native-Windows `solana-test-validator` has a real history of exactly this genesis-unpacking failure ([anza-xyz/agave#24](https://github.com/anza-xyz/agave/issues/24), [solana-labs/solana#23666](https://github.com/solana-labs/solana/issues/23666)), and the ecosystem's own fix is WSL or Linux, not native Windows -- which converges on the same firmware-virtualization blocker documented under "Toolchain" above. **Resolved 18 Sept 2026**, not by fixing the local validator, but by sidestepping it: the same fast-clock build was deployed to a *throwaway devnet program* instead (see `unstake-success-devnet-test.mjs` above), closed afterward. The feature and local-validator build path stay in the repo for whenever WSL (or another Linux/Mac environment) is available, but they're no longer the only route to this coverage.

Do not deploy to mainnet, or point this at any real ACT, before: a real test suite runs clean against this devnet deployment, and someone other than the person who wrote it has reviewed the program. (`unstake`'s success path itself is now exercised -- see above.) This is the protocol's first custom on-chain program — see STAKING_DESIGN.md for why that raises the bar relative to everything else in this repo.
