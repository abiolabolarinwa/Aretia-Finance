# ACT Staking — Design Record (Part VIII, Section 30 infrastructure)

**Status:** Program source written, **not yet compiled, not yet tested, not deployed anywhere** — not devnet, not mainnet. This document and `program/act-staking/` are the design and implementation; the toolchain needed to actually build it is not yet available in this environment (see "Toolchain gap" below).

**Scope, per Section 32:** this is infrastructure only. It does not gate access to anything today, because Stage Two does not exist today. What it does is let a wallet lock ACT for a chosen duration and have that produce a deterministic, on-chain-readable tier. Nothing about that tier currently unlocks a data room, a marketplace listing, or any investment opportunity — there isn't one yet. Section 30's two hard rules apply unconditionally: no tier confers investor eligibility, and ACT's marketed value must never be represented as a function of any gated project's returns. This program does not touch either of those; it only computes and stores a number.

This is also the protocol's **first custom on-chain program**. Everything before this — the mint, the transfer-fee extension, the treasury multisig — is native Token-2022 configuration and Squads multisig instructions, built with raw `@solana/web3.js` scripts (see `scripts/rebuild-mint/`, `scripts/treasury-v2-setup/`). No custom program has been deployed before this one. That matters for risk: this is new code holding user funds, not a config change to code someone else wrote and the ecosystem has already exercised at scale. It should not go to mainnet with real value locked in it without the same devnet-first, verify-on-chain discipline already used for the mint and treasury (see `MINT_V2.md`, `TREASURY_V2.md`), and ideally an independent review before any meaningful amount of ACT is at stake — literally, in this case.

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

**Tiers** (CAS thresholds, expressed against the fixed 1,000,000,000 ACT supply for legibility):

| Tier | CAS threshold | Equivalent at 1.00× (30-day lock) |
|---|---|---|
| 0 — Public | below 1,000,000 | — |
| 1 — Observer | ≥ 1,000,000 | 0.10% of supply |
| 2 — Participant | ≥ 5,000,000 | 0.50% of supply |
| 3 — Partner | ≥ 20,000,000 | 2.00% of supply |
| 4 — Anchor | ≥ 75,000,000 | 7.50% of supply |

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
- `paused: bool` — circuit breaker; when true, `stake` is rejected but `unstake` still works, so a bug freezes new deposits without trapping anyone's existing funds
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
  7. `lock_days` on a top-up must be ≥ the days remaining until the existing `unlock_at` — you can extend or add to a commitment, never shorten one already in force.
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

ACT carries a Token-2022 transfer fee (3.5% currently, treasury-governed, Section 14). Every transfer into or out of the vault is subject to it, including stakes and unstakes. Two wrong ways to handle this, both worth naming so they don't get reintroduced later:

- Trusting the `amount` parameter as what actually landed — wrong, because up to the configured max fee is withheld before the vault ever sees it.
- Hardcoding the current 3.5% rate to compute net — wrong, because Section 11 already changed this rate once by governance vote and can again; a hardcoded rate silently desyncs from reality the next time it does.

Reading the vault's own balance immediately before and after the CPI is correct under both a stable and a changing fee rate, with no assumption about what the rate currently is baked into the program at all.

---

## Toolchain gap — what's needed before this can be built

Solana CLI is installed natively (`solana-cli 4.2.1`, confirmed on this machine). Rust, Cargo, and Anchor are not — and this repo's existing on-chain scripts are all named `*-wsl.sh`, meaning the mint and treasury work was done through WSL, and WSL (Ubuntu, installed but stopped) currently cannot start: virtualization is disabled in this machine's firmware. That's a BIOS/UEFI setting plus a reboot, which has to happen on the physical machine — not something fixable from here.

Two ways forward, in order of fit with how this project already works:

1. **Fix WSL** — enable virtualization in firmware, then `wsl --install` / start Ubuntu, then inside it: `rustup`, `solana-install`, `cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install latest`. Matches every existing script's own convention exactly.
2. **Native Windows Rust + Anchor** — install `rustup-init.exe` (MSVC target, needs Visual Studio Build Tools too) and `cargo install anchor-cli --locked`. Anchor's own docs still point Windows users at WSL first; native builds work for many people but are less proven, and if something fails partway through it's a toolchain problem to debug, not a program-logic one.
3. **A disposable Linux dev environment** (cloud sandbox, spare Linux/Mac machine) just for the compile/test/devnet-deploy cycle, keeping the source of truth in this repo either way.

None of this blocks writing or reviewing the program source, which is already done. It blocks compiling it, running it against a local validator, and deploying to devnet — the three steps that have to happen, in that order, with each verified on-chain before the next, before this touches mainnet or a real ACT balance. That sequencing is the same discipline `MINT_V2.md` and `TREASURY_V2.md` already document for everything else in this protocol.

## Still open

- [ ] Program not yet compiled — `program/act-staking/` has never seen `anchor build` or `cargo build-sbf` run against it. Rust/Anchor syntax has been written carefully but not machine-checked; treat it as a first draft until it compiles clean.
- [ ] No devnet deployment, no test suite run, no independent review — required, in that order, before any mainnet deployment, per this document's own stated risk (first custom program, holds user funds).
- [ ] Tier thresholds and duration multipliers above are illustrative placeholders with no holder-distribution data behind them; revisit once ACT is trading.
- [ ] No staking UI built yet. A `website/stake.html` page reading `UserStake` client-side (matching Section 24.3's pattern) is the natural next piece once the program is verified on devnet — not before, so the UI isn't built against an interface that might still change.
- [ ] Not linked from site navigation yet, deliberately — this stays unlisted until it's a real, tested thing a wallet can interact with, not a placeholder page.
