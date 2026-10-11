# On-chain tests (LiteSVM) for act-presale and act-staking

These run the **compiled SBF programs** inside LiteSVM, so account constraints (`has_one`, PDA seeds, `address =`,
`close =`), CPIs and rent behave as on a real validator. Instructions are built by hand from the Anchor discriminator and
Borsh layout (same approach as `aretia-wallet/programs/aretia-safesend/tests`).

```bash
# 1. build the programs (once per change to program source)
cargo install cargo-build-sbf --locked --version 4.4.0     # downloads Solana platform-tools on first use
(cd ../act-staking && cargo build-sbf)
(cd ../act-presale && cargo build-sbf)
# 2. run
cargo +1.97.1 test
```

Standalone crate on purpose (own `[workspace]` and lockfile): LiteSVM needs newer Solana crates than the Anchor 0.30.1
programs. `target/deploy/*-keypair.json` files that `build-sbf` generates are git-ignored; never commit them.

| File | Covers |
|---|---|
| `tests/presale.rs` | F-15 who may finalize (incl. end-to-end refund after a stranger finalizes, sweep destination binding, hard-cap case); F-16 Pyth confidence boundary + the pre-existing oracle checks; F-17 handoff; **F-20 characterization** |
| `tests/staking.rs` | F-17 handoff |
| `tests/common/handoff.rs` | the F-17 scenarios, shared so both programs are held to identical behaviour |

Not covered: `buy`/`claim`/`refund` with the Token-2022 fee-bearing ACT mint, `fund_act_reserve`, vesting math, staking
`stake`/`unstake`. Those need a Token-2022 TransferFee mint fixture (the SafeSend tests contain one to reuse).

`characterization_f20_*` pins **current** behaviour that is probably a defect (sales are not capped by the funded ACT
reserve). When that is fixed the test must be replaced by one asserting the guard.
