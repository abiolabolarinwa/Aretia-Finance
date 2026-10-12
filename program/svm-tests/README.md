# On-chain tests (LiteSVM) for act-staking

These run the **compiled SBF program** inside LiteSVM, so account constraints (`has_one`, PDA seeds, `address =`,
`close =`), CPIs and rent behave as on a real validator. Instructions are built by hand from the Anchor discriminator and
Borsh layout (same approach as `aretia-wallet/programs/aretia-safesend/tests`).

```bash
# 1. build the program (once per change to program source)
cargo install cargo-build-sbf --locked --version 4.4.0     # downloads Solana platform-tools on first use
(cd ../act-staking && cargo build-sbf)
# 2. run
cargo +1.97.1 test
```

Standalone crate on purpose (own `[workspace]` and lockfile): LiteSVM needs newer Solana crates than the Anchor 0.30.1
program. `target/deploy/*-keypair.json` files that `build-sbf` generates are git-ignored; never commit them.

| File | Covers |
|---|---|
| `tests/staking.rs` | F-17 two-step authority handoff (11 scenarios) |
| `tests/common/handoff.rs` | the handoff scenarios, written against the propose/accept/cancel interface so another program can reuse them |
| `tests/common/mod.rs` | helpers, including a Token-2022 mint with a transfer fee (`create_fee_mint`), `mint_to`, ATA helpers |

Not covered: `stake` / `unstake` / tier math and fee-bearing transfers. The Token-2022 fee-mint fixture already exists
here, so these are the natural next tests.

History: this crate also held the on-chain suite for `act-presale` (finalize rules, Pyth confidence, reserve enforcement).
That program was removed on 2026-10-12 when the presale was cancelled; the suite is in git history.

Mutation-check discipline: restore program source from a **backup copy**, never `git checkout` (it reverts uncommitted work).
