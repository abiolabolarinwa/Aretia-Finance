# act-staking

ACT staking program (Aretia Finance, Part VIII Sec. 30 infrastructure). Full design record, tier formula, account layout, and the build log: see [`../../STAKING_DESIGN.md`](../../STAKING_DESIGN.md) at the repo root.

**Compiles clean and is deployed on devnet** at `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`, confirmed via `solana program show`. **No instruction has been called yet** (the deploy proves the bytecode loads and is executable, not that `stake`/`unstake`/etc. behave correctly), **no test suite has run**, and **no independent review** has happened. See STAKING_DESIGN.md's "Build log" and "Still open" sections before assuming more progress than that.

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

Upgrade authority currently sits on a throwaway devnet deployer key, not the treasury multisig -- fine for iteration, but transfer it (`solana program set-upgrade-authority`) before treating this deployment as anything more than scratch, and before any mainnet deploy repeats this pattern.

## Next: exercise the instructions

No instruction has been called yet. The deploy proves the bytecode loads and is executable, nothing about whether `initialize_config`/`stake`/`unstake` actually work. Next step is a real client (the `tests/act-staking.ts` skeleton, or a manual script) calling `initialize_config` against the devnet deployment above and checking the resulting `StakeConfig` account.

Do not deploy to mainnet, or point this at any real ACT, before: a real test suite runs clean against this devnet deployment, and someone other than the person who wrote it has reviewed the program. This is the protocol's first custom on-chain program — see STAKING_DESIGN.md for why that raises the bar relative to everything else in this repo.
