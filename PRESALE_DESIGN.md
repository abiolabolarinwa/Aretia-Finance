# ACT Public Presale — Design Record

**Status (drafted [date]):** Program written, not yet compiled/tested. Devnet only. **Not deployed anywhere.** No mainnet deployment without a separate, explicit go-ahead — see "Deployment sequence" below.

**Legal status:** `ATTORNEY_BRIEF.md` §4 Q6 was scoped against "no presale or private offering planned." Counsel's 1 Sept 2026 approval of the entity structure and securities framing was given on that premise, not against a presale. Per this project's own confirmation, legal has since reviewed and cleared proceeding with a presale under this structure. That clearance should be treated the same way the two prior addenda in `ATTORNEY_BRIEF.md` (management-fee increase, registration-fee mechanism) are treated: recorded as its own dated note, not folded silently into the original brief.

**Source doc:** built against `pre sale.docx` (the brief this repo's presale work was scoped from) plus the audit findings below.

---

## What this is not

Same distinction the source doc insists on: the presale is **not** the Climate Catalyst Fund. The presale raises initial capital to launch ACT and seed liquidity. The 3.5% transfer fee is the separate, recurring mechanism that funds the Catalyst Fund on every trade thereafter, independent of whether the presale happened at all. `act-presale` and `act-staking` remain intentionally separate programs for the same reason.

## Confirmed mainnet ACT mint state (verified via RPC, [date])

| Field | Value |
|---|---|
| Mint | `7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG` |
| Program | spl-token-2022 |
| Decimals | 9 |
| Supply | 1,000,000,000 ACT |
| Mint authority | `null` (revoked) |
| Freeze authority | `null` (never granted) |
| Transfer fee | 350 bps (3.5%), maximum fee = u64::MAX (uncapped) |
| Fee-config / withdraw-withheld authority | Treasury multisig (`GtKGE6...bryZnA`) |

The uncapped maximum fee means every transfer this program makes — funding the vault, paying out a claim, sweeping unsold ACT — loses 3.5% at the protocol level, with no size-based exemption.

## Presale parameters

| Parameter | Value |
|---|---|
| Window | Oct 1 – Dec 1, 2026 (62 days) |
| Allocation | 100,000,000 ACT, **net**, to purchasers |
| Price | $0.01 / ACT |
| Hard cap | $1,000,000 |
| Soft cap | $500,000 (refund everyone if missed) |
| Min buy | $10 (first contribution only; not re-checked on top-ups) |
| Max buy | $10,000 cumulative per wallet |
| Vesting | 25% at TGE, 75% linear over 180 days |
| Payment token | USDC (recommended — see "Open items") |
| Liquidity target | 80% of net proceeds, scaling with actual raise, not a fixed dollar promise |

## The two-hop fee problem, and how this program handles it

Vesting requires ACT to sit in a program-owned vault between "sold" and "claimed." That's two fee-bearing transfers per token, not one:

1. **Funding the vault** (`fund_act_reserve`): treasury → vault. Loses 3.5%.
2. **Paying out a claim** (`claim`): vault → buyer, at each vesting release. Loses 3.5% again.

Naively reserving the doc's original single-hop estimate (100M / 0.965 ≈ 103.6M gross) only covers hop 2. To land 100M net after *both* hops compounding (0.965² ≈ 0.931), the treasury-side send for `fund_act_reserve` needs to be closer to **100M / 0.965² ≈ 107.4M ACT**, which lands roughly 103.6M net in the vault after hop 1 — matching the doc's number, but as the amount available for hop 2, not the treasury-side send.

Rather than hardcode 3.5% anywhere (governance could recalibrate it — see `MINT_V2.md`), this program:

- Tracks every buyer's entitlement in **net** terms only (`BuyerAccount.act_allocated_net`).
- Funds the vault using the **balance-delta** pattern already established in `act-staking`'s `stake` (read the vault's balance before/after the CPI, trust that delta) — correct regardless of the fee rate at call time.
- At claim time, reads the ACT mint's live `TransferFeeConfig` extension and calls `calculate_inverse_epoch_fee` to work out the gross amount to send so the buyer nets (at least) their vested entitlement, verified again via balance-delta after the transfer. This is the same "how much do I send so the recipient nets X" problem the whitepaper's §14.5 management-fee gross-up already solves, applied here per-claim instead of once.
- `sweep_unsold_act` lets the authority reclaim whatever's left in the vault beyond what's still owed, once the sale is finalized — so an under-hard-cap raise doesn't strand ACT in the vault indefinitely.

**This has not yet been proven correct by a test.** `calculate_inverse_epoch_fee`'s exact behavior (rounding direction in particular) needs to be confirmed against a real devnet transfer before this is trusted with real value — see "Open items."

## Program architecture (`program/act-presale/`)

Anchor 0.30.1, mirrors `act-staking`'s conventions (same `anchor_spl::token_interface` usage, same balance-delta fee handling, same PDA/`has_one` authority style).

**Accounts**
- `PresaleConfig` — singleton, PDA seeds `[b"presale_config"]`. Authority, mints, vaults, treasury destinations, price, window, caps, vesting config, running totals (`total_raised_payment`, `total_act_sold_net`, `total_act_claimed_net`, `act_reserve_net`), `status` (0=Active, 1=Finalized, 2=Refunding), `paused`.
- `BuyerAccount` — PDA seeds `[b"presale_buyer", buyer_pubkey]`. Owner, cumulative payment contributed, net ACT allocated, net ACT claimed so far, refunded flag.

**Instructions**
- `initialize_presale` — one-time setup, authority-gated, creates config + both vault ATAs. Moves no tokens.
- `fund_act_reserve` — authority-gated, tops up the ACT vault (balance-delta recorded).
- `buy` — public, validates window/pause/min-first-buy/max-cumulative/hard-cap, escrows payment token, computes and records net ACT entitlement.
- `finalize` — authority-gated, after window close or hard cap hit. Soft cap met: sweeps escrow to treasury, sets `tge_ts = now`. Soft cap missed: flips to `Refunding`, moves nothing.
- `refund` — buyer-callable under `Refunding`, returns exactly what that wallet put in.
- `claim` — buyer-callable under `Finalized`, past TGE. Pays out newly-vested net ACT, grossed up per the section above.
- `sweep_unsold_act` — authority-gated, after `Finalized`, reclaims vault ACT beyond what's still owed.
- `set_paused` / `set_config_authority` — admin controls. `set_config_authority` shipped from day one this time; `act-staking` had to add it after the fact.

**Authority:** recommend the same Squads multisig already used for treasury and fee-config, not a new single key — consistent with the rest of the protocol's admin model.

## Open items (block mainnet, not devnet)

1. **`calculate_inverse_epoch_fee` correctness** — needs a real devnet transfer confirming its rounding matches this program's assumptions before any real value depends on it.
2. **DEX/AMM Token-2022 compatibility** — which Solana AMM correctly handles `TransferFeeConfig` deposits/withdrawals/swaps for this specific mint has not been verified. Blocks the liquidity step, not the presale program itself.
3. **Payment token decision** — USDC assumed throughout (predictable USD pricing, no oracle needed). SOL/USDT remain options if there's a reason to prefer them; switching is a config-time choice (`payment_mint`), not a rewrite.
4. **`act-staking` devnet-deployment discrepancy** — noted in the presale audit, unrelated to this program, but worth resolving before both are described publicly as "live on devnet."
5. **Full devnet exercise**: buy → hard-cap rejection → finalize (both soft-cap-met and soft-cap-missed paths) → refund → claim across multiple vesting checkpoints → sweep. None of this has been run yet.

## Deployment sequence

1. Compile + fix (this repo's `cargo check` / `anchor build`).
2. Devnet deploy, using a devnet-only ACT-like Token-2022 mint with the same 3.5% fee config, and devnet USDC.
3. Exercise every instruction above end to end on devnet, unit + integration tests.
4. Independent security review.
5. **Explicit, separate approval before mainnet deployment or before this program ever touches the real ACT mint or real funds.**
