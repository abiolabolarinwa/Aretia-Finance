# act-staking

ACT staking program (Aretia Finance, Part VIII Sec. 30 infrastructure). Full design record, tier formula, and account layout: see [`../../STAKING_DESIGN.md`](../../STAKING_DESIGN.md) at the repo root.

**Not yet built.** This has never seen `anchor build`. Before doing anything else, read STAKING_DESIGN.md's "Toolchain gap" section — Rust/Cargo/Anchor aren't installed in the environment this was written in, and the repo's usual WSL path is currently blocked by a firmware setting.

Once the toolchain is available:

```bash
# from program/act-staking/
anchor keygen new -o target/deploy/act_staking-keypair.json
# then paste the printed pubkey into Anchor.toml (both [programs.*] entries)
# and into declare_id!(...) in programs/act-staking/src/lib.rs

anchor build
anchor test          # runs tests/act-staking.ts against a local validator
```

Do not run `anchor deploy --provider.cluster devnet`, let alone mainnet, before `anchor test` passes clean and someone other than the person who wrote it has read the program. This is the protocol's first custom on-chain program — see STAKING_DESIGN.md for why that raises the bar relative to everything else in this repo.
