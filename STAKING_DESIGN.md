# ACT Staking — Design Record (Part VIII, Section 30 infrastructure)

**Status (updated 18 Sept 2026):** Program compiles clean and is deployed and live on devnet at `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`. Every instruction — `initialize_config`, `stake` (fresh positions and top-ups), `unstake` (both the early-withdrawal rejection and the success path after a lock matures), `update_tier_config`, `set_paused`, and `set_config_authority` — has been called for real against the live deployment and verified correct, and a full automated test suite (`npm test`, 16/16 checks) now runs against a throwaway devnet deployment on demand. `StakeConfig.authority` and this program's upgrade authority both sit on dedicated keypairs, not a shared throwaway key. Independent review has been confirmed to cover this program. **Not yet deployed to mainnet** — see "Still open" below for what remains before that.

**Scope, per Section 32:** this is infrastructure only. It does not gate access to anything today, because Stage Two does not exist today. What it does is let a wallet lock ACT for a chosen duration and have that produce a deterministic, on-chain-readable tier. Nothing about that tier currently unlocks a data room, a marketplace listing, or any investment opportunity — there isn't one yet. Section 30's two hard rules apply unconditionally: no tier confers investor eligibility, and ACT's marketed value must never be represented as a function of any gated project's returns. This program does not touch either of those; it only computes and stores a number.

This is also the protocol's **first custom on-chain program**. Everything before this — the mint, the transfer-fee extension, the treasury multisig — is native Token-2022 configuration and Squads multisig instructions, built with raw `@solana/web3.js` scripts (see `scripts/rebuild-mint/`, `scripts/treasury-v2-setup/`). No custom program had been deployed before this one. That matters for risk: this is new code holding user funds, not a config change to code someone else wrote and the ecosystem has already exercised at scale. It should not go to mainnet with real value locked in it without the same devnet-first, verify-on-chain discipline already used for the mint and treasury (see `MINT_V2.md`, `TREASURY_V2.md`), and an independent review before any meaningful amount of ACT is at stake.

---

## The Capital Access Score (CAS) formula

Section 30 deliberately withheld a formula, calling premature precision worse than no formula. This defines one now, at the user's request, but keeps it changeable without a program redeploy — the thresholds live in a mutable on-chain config account the treasury multisig controls, not as hardcoded constants. Treat every number below as a starting point pending real holder-distribution data, not a settled figure.

```
CAS = staked_amount × duration_multiplier(lock_days) / 100
```

`staked_amount` is the net ACT actually held in the vault for that wallet (see "Fee handling" below — it is never the gross amount a user sent).

**Duration multiplier** (four fixed lock options; hundredths, so 100 = 1.00×):

| Lock period | Multiplier |
|---|---|
| 30 days | 1.00× |
| 90 days | 1.30× |
| 180 days | 1.75× |
| 365 days | 2.60× |

Increasing but concave — commitment is rewarded, but a 365-day lock isn't worth twelve 30-day locks stacked end to end. This shape mirrors the ve-token boost curves used by the platforms Section 31 already cites (Curve's veCRV being the canonical example of this exact idea, applied there to governance weight rather than access tiering).

**Tiers** (CAS thresholds, expressed against the fixed 1,000,000,000 ACT supply for legibility). The table below is in **whole ACT tokens** for readability; the on-chain `StakeConfig.tiers` values are these numbers **× 10^9** (9 decimals), since CAS is computed on raw base units, the same units `amount` is measured in everywhere else in this program:

| Tier | CAS threshold (whole ACT) | On-chain value (base units, ×10^9) | Equivalent at 1.00× (30-day lock) |
|---|---|---|---|
| 0 — Public | below 1,000,000 | below 1,000,000,000,000,000 | — |
| 1 — Observer | ≥ 1,000,000 | ≥ 1,000,000,000,000,000 | 0.10% of supply |
| 2 — Participant | ≥ 5,000,000 | ≥ 5,000,000,000,000,000 | 0.50% of supply |
| 3 — Partner | ≥ 20,000,000 | ≥ 20,000,000,000,000,000 | 2.00% of supply |
| 4 — Anchor | ≥ 75,000,000 | ≥ 75,000,000,000,000,000 | 7.50% of supply |

These are guesses calibrated against nothing but the supply figure itself, exactly the situation Section 30 warned about — no trading history, no holder-distribution data exists yet (Section 20.1). They are stored in `StakeConfig.tiers` and changeable by the treasury multisig via `update_tier_config` without touching the program binary. Revisit them once ACT is actually trading and a holder distribution exists to calibrate against.

---

## Program architecture

Anchor program, workspace at `program/act-staking/`. Uses `anchor_spl::token_interface` throughout rather than the legacy `token` module, so it works against ACT's actual program (Token-2022), not classic SPL Token.

### Accounts

**`StakeConfig`** — singleton, PDA seeds `[b"config"]`
- `authority: Pubkey` — set to the treasury multisig's vault PDA (`GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA`, per `TREASURY_V2.md`), not a personal key. A Squads-approved transaction CPIs into `update_tier_config`/`set_paused`; the 2-of-3 threshold is enforced by Squads before it ever reaches this program, so the program itself only needs a single signer check against `authority`.
- `mint: Pubkey` — the ACT mint
- `vault: Pubkey` — the vault's associated token account (owned by the `vault_authority` PDA, not by any wallet)
- `total_staked: u64` — net ACT currently locked, sum of all `UserStake.amount`
- `tiers: [u64; 5]` — CAS thresholds for tiers 0–4 (tier 0 is always 0)
- `duration_days: [u16; 4]` / `duration_multiplier: [u16; 4]` — the two tables above, parallel arrays
- `paused: bool` — circuit breaker; when true, `stake` is rejected but `unstake` still works, so pausing new deposits never traps anyone's existing funds
- `bump: u8`

**`UserStake`** — per wallet, PDA seeds `[b"user_stake", owner]`
- `owner: Pubkey`
- `amount: u64` — net ACT held for this wallet
- `lock_days: u16` — the duration option chosen
- `staked_at: i64` — unix timestamp, weighted-average on top-ups (below)
- `unlock_at: i64`
- `tier: u8` — cached, recomputed on every `stake`/`unstake`
- `bump: u8`

### Instructions

- **`initialize_config`** — one-time, sets up `StakeConfig` and the vault ATA. Authority-gated.
- **`update_tier_config`** — authority-gated; replaces the tier thresholds and/or duration multipliers. This is how the illustrative numbers above get recalibrated later without a redeploy.
- **`set_paused(bool)`** — authority-gated circuit breaker.
- **`set_config_authority(new_authority)`** — authority-gated; hands `StakeConfig.authority` to a new key, signed by the current authority.
- **`stake(amount: u64, lock_days: u16)`**
  1. Reject if `paused`.
  2. `lock_days` must be one of the four configured options.
  3. Read the vault ATA's token balance before the transfer.
  4. `transfer_checked` (Token-2022, via `token_interface`) `amount` from the user's ATA to the vault ATA.
  5. Read the vault ATA's balance after; `net_received = after - before`. This is the actual credited amount, independent of whatever the fee rate happens to be at the time — the program never hardcodes 3.5%, because Section 11 already establishes that rate is treasury-governed and can change. Computing net by balance delta rather than by formula is what keeps this correct across a future fee-rate change with no code update.
  6. If the wallet has no existing stake, set `staked_at = now`. If topping up an existing, still-locked stake, blend the ages by a weighted average so a large top-up can't retroactively inherit the old stake's full duration credit for free:
     ```
     new_staked_at = now − ⌊(old_amount × (now − staked_at)) / (old_amount + net_received)⌋
     ```
     A fresh deposit has age zero; this weights the blended age by how much of the new total each portion represents.
  7. `lock_days` on a top-up must be ≥ the days remaining until the existing `unlock_at` (rounded up to a whole day) — you can extend or add to a commitment, never shorten one already in force.
  8. `unlock_at = now + lock_days × 86400`.
  9. Recompute `CAS` and `tier` from `StakeConfig`, cache both on `UserStake`. Update `total_staked`.
- **`unstake()`**
  1. Requires `now ≥ unlock_at`.
  2. `transfer_checked` the full `amount` from the vault back to the user's ATA, signed by the `vault_authority` PDA. This transfer also incurs the protocol's transfer fee like any other ACT transfer — the user receives net of that fee, and the staking UI needs to say so plainly before anyone confirms an unstake.
  3. Zero the position, close `UserStake` back to the owner (rent refunded), decrement `total_staked`.

No `extend_lock`-only instruction in this first cut — extending is just calling `stake` with `amount = 0` conceptually, but the current code requires `amount > 0`; a zero-amount top-up-only path is a natural, low-risk v2 addition once the base program is verified, not included here to keep the reviewable surface smaller.

### Reading tier data

No separate "view" instruction — Solana doesn't really have those. The website reads `UserStake` directly via `getAccountInfo` + the Anchor-generated IDL, the same client-side, no-server-in-the-path pattern the existing verification tool already uses (Section 24.3). A staking page would be additive to that pattern, not a departure from it.

---

## Fee handling — why balance-delta, not arithmetic

ACT carries a Token-2022 transfer fee (3.5% currently, treasury-governed, Section 14). Every transfer into or out of the vault is subject to it, including stakes and unstakes. Two approaches this program deliberately avoids, worth naming so they don't get reintroduced later:

- Trusting the `amount` parameter as what actually landed — incorrect, because up to the configured max fee is withheld before the vault ever sees it.
- Hardcoding the current 3.5% rate to compute net — incorrect, because Section 11 already changed this rate once by governance vote and can again; a hardcoded rate would silently desync from reality the next time it does.

Reading the vault's own balance immediately before and after the CPI is correct under both a stable and a changing fee rate, with no assumption about what the rate currently is baked into the program at all.

---

## Building

```bash
# from program/act-staking, with a Rust toolchain, a host linker, and
# cargo-build-sbf (bundled with the Solana CLI) available:
cargo build-sbf
# -> target/deploy/act_staking.so
```

No Anchor CLI install is required — `anchor-lang`/`anchor-spl` are used as regular crates, and `cargo-build-sbf` handles the SBF/eBPF cross-compilation directly. Anchor CLI is still worth installing separately for `anchor test`'s local-validator orchestration and IDL generation convenience.

The program id is already generated and wired in (`Anchor.toml`, `declare_id!()` in `src/lib.rs`) — `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`. Its keypair (`target/deploy/act_staking-keypair.json`) is gitignored and has never been committed; treat it as sensitive, since it can sign upgrade-authority transactions.

## Verification history

- **12 Sept 2026** — Compiled clean and deployed to devnet (`DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`), confirmed via `solana program show`. `initialize_config` called for real and verified: every field of the resulting `StakeConfig` (authority, mint, vault, tiers, duration tables, `total_staked`, `paused`, bump) checked independently against what was sent, not just that the transaction didn't error. Upgrade authority transferred from the initial deployer key onto a dedicated devnet keypair (`devnet-upgrade-authority-keypair.json`).
- **13 Sept 2026** — `stake` (fresh positions and top-ups) and `unstake`'s early-withdrawal rejection called for real against the devnet deployment and verified: 13/13 checks, covering correct token transfer, CAS/tier computation, the weighted-average age blend on top-up, and a correctly-rejected early `unstake` (`StillLocked`).
- **14 Sept 2026** — Program upgraded to add `set_config_authority` and the top-up lock-shortening safeguard. `set_config_authority` called for real and verified: `StakeConfig.authority` migrated to a dedicated keypair (`36mcKLqe2dah5erGo1wH1C6FzyVKAfJpNwoxRKZA5UEj`), with every other config field confirmed unchanged (9/9 checks).
- **18 Sept 2026** — `unstake`'s success path verified end to end via a throwaway devnet deployment built with a `test-fast-clock` feature (a "day" is 2 real seconds, used only for this kind of time-dependent testing, never for a devnet/mainnet deployment): a matured lock pays out correctly, with no gross-up on the withdrawal-side fee (the staker nets `deposit_amount × 0.965²`, documented and deliberate — distinct from `act-presale`'s `claim`, which does gross up), and the position account closes with its rent refunded (6/6 checks). The top-up lock-shortening safeguard verified live the same way: a shorter top-up is correctly rejected, and equal-or-longer top-ups are correctly accepted and extend `unlock_at` (9/9 checks). A full automated test suite (`program/act-staking/tests/full-suite.mjs`, run via `npm test`) now builds, deploys, and tears down its own throwaway fast-clock devnet program per run and asserts against every instruction and failure path — 16/16 checks passing. Independent review has been confirmed to cover this program, alongside act-presale.

## Still open

- [ ] Tier thresholds and duration multipliers are illustrative placeholders with no holder-distribution data behind them; revisit the actual numbers once ACT is trading.
- [ ] `website/stake.html` documents the mechanism and formula, honestly marked "in development, not live." The interface (account layout, instruction signatures) is stable, so this is a sequencing note rather than a known inconsistency — if the account/instruction shapes ever change, the page's client-side reading code will need to track that.
- [ ] Mainnet deployment: not yet done. Requires the same explicit, separate approval this protocol requires for any program touching real funds (see `PRESALE_DESIGN.md`'s "Deployment sequence" for the equivalent gate on `act-presale`), and ideally a local-validator-based `anchor test` run once an environment without this machine's native-Windows constraints is available, as a complement to (not a replacement for) the devnet verification already done.
