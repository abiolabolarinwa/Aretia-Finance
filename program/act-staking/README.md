# act-staking

ACT staking program (Aretia Finance, Part VIII Sec. 30 infrastructure). Full design record, tier formula, account layout, and the build log: see [`../../STAKING_DESIGN.md`](../../STAKING_DESIGN.md) at the repo root.

**Compiles clean.** `cargo build-sbf` (release) produces a valid `target/deploy/act_staking.so`. **Not yet deployed anywhere** (devnet deploy is written up but blocked on a rate-limited public faucet, not on code), **no test suite has run**, and **no independent review** has happened. See STAKING_DESIGN.md's "Build log" and "Still open" sections before assuming more progress than that.

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

## Deploying to devnet (next step)

```bash
solana config set --url devnet
solana airdrop 1 <path-to-a-deployer-keypair>   # was rate-limited last attempt; retry later or fund manually
solana program deploy target/deploy/act_staking.so --url devnet --keypair <path-to-a-deployer-keypair> --program-id target/deploy/act_staking-keypair.json
```

Do not deploy to mainnet, or point this at any real ACT, before: the devnet deployment above actually happens and is verified on-chain, a real test suite runs clean (`tests/act-staking.ts` is currently an unexecuted skeleton), and someone other than the person who wrote it has reviewed the program. This is the protocol's first custom on-chain program — see STAKING_DESIGN.md for why that raises the bar relative to everything else in this repo.
