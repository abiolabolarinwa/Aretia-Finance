# ACT Public Presale — Design Record

**Status (updated 18 Sept 2026):** Deployed and exercised on devnet at `5hmgnujNib14NDkEgRsLpY3H8SBDCsLryiymNKY6fWku`. Every instruction has been called for real against the devnet deployment and verified: the happy path (buy in both currencies, finalize on hard-cap-reached, sweep to the real Squads treasury ATAs, claim at TGE plus partial linear vesting), the soft-cap-missed path (buy, finalize into `Refunding`, refund returns exactly what was put in, a second refund attempt correctly rejected), multi-checkpoint linear vesting, native-SOL contribution and refund against a live Pyth price feed, and gross-up accounting for the vault-to-buyer claim transfer. Independent review has been confirmed to cover this program. DEX/AMM compatibility (Raydium, Orca, Meteora) has been proven on devnet with real transfer-fee-token swaps, and Raydium's pool-creation instruction has been proven end to end (aside from real SOL for the last account's rent) against the real ACT mint and real USDC via read-only mainnet simulation. **Devnet only. Not deployed to mainnet.** No mainnet deployment without a separate, explicit go-ahead — see "Deployment sequence" below.

The devnet run used throwaway test-ACT/test-USDC/test-USDT mints, with the treasury destinations wired to the **real mainnet Squads vault** (`GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA`) — devnet ATAs owned by that address, which has no signing authority on devnet, so nothing could be spent from them; the point was only to prove `finalize`/`sweep_unsold_act` route to the correct address, which they do.

**Legal status:** `ATTORNEY_BRIEF.md` §4 Q6 was scoped against "no presale or private offering planned." Counsel's 1 Sept 2026 approval of the entity structure and securities framing was given on that premise, not against a presale. Per this project's own confirmation, legal has since reviewed and cleared proceeding with a presale under this structure. That clearance is recorded the same way the two prior addenda in `ATTORNEY_BRIEF.md` (management-fee increase, registration-fee mechanism) are treated: as its own dated note, not folded silently into the original brief.

**Independent security review:** confirmed by the project owner (18 Sept 2026) as done/cleared. Recorded here as self-reported, per this file's own convention for legal/review sign-offs — not independently re-verified by this session.

**Source doc:** built against `pre sale.docx` (the brief this repo's presale work was scoped from).

---

## What this is not

Same distinction the source doc insists on: the presale is **not** the Climate Catalyst Fund. The presale raises initial capital to launch ACT and seed liquidity. The 3.5% transfer fee is the separate, recurring mechanism that funds the Catalyst Fund on every trade thereafter, independent of whether the presale happened at all. `act-presale` and `act-staking` remain intentionally separate programs for the same reason.

## Confirmed mainnet ACT mint state (verified via RPC)

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
| Payment token | USDC and USDT (both accepted; index-matched arrays in config), plus SOL via `buy_with_sol` (priced live against Pyth's SOL/USD pull oracle) |
| Liquidity target | 80% of net proceeds, scaling with actual raise, not a fixed dollar promise |

## The two-hop fee problem, and how this program handles it

Vesting requires ACT to sit in a program-owned vault between "sold" and "claimed." That's two fee-bearing transfers per token, not one:

1. **Funding the vault** (`fund_act_reserve`): treasury → vault. Loses 3.5%.
2. **Paying out a claim** (`claim`): vault → buyer, at each vesting release. Loses 3.5% again.

Naively reserving the doc's original single-hop estimate (100M / 0.965 ≈ 103.6M gross) only covers hop 2. To land 100M net after *both* hops compounding (0.965² ≈ 0.931), the treasury-side send for `fund_act_reserve` needs to be closer to **100M / 0.965² ≈ 107.4M ACT**, which lands roughly 103.6M net in the vault after hop 1 — matching the doc's number, but as the amount available for hop 2, not the treasury-side send.

Rather than hardcode 3.5% anywhere (governance could recalibrate it — see `MINT_V2.md`), this program:

- Tracks every buyer's entitlement in **net** terms only (`BuyerAccount.act_allocated_net`).
- Funds the vault using the **balance-delta** pattern also used in `act-staking`'s `stake` (read the vault's balance before/after the CPI, trust that delta) — correct regardless of the fee rate at call time.
- At claim time, reads the ACT mint's live `TransferFeeConfig` extension and calls `TransferFee::calculate_pre_fee_amount` (via `get_epoch_fee`) to work out the gross amount to send so the buyer nets (at least) their vested entitlement, verified again via balance-delta after the transfer, with a bounded top-up retry if the estimate falls short. This is the same "how much do I send so the recipient nets X" problem the whitepaper's §14.5 management-fee gross-up already solves, applied here per-claim instead of once.
- `sweep_unsold_act` lets the authority reclaim whatever's left in the vault beyond what's still owed (with a small fixed safety margin on the "still owed" estimate), once the sale is finalized — so an under-hard-cap raise doesn't strand ACT in the vault indefinitely.

Proven correct by a real devnet transfer (18 Sept 2026) — `claim` correctly grosses up and pays out net entitlements against a real fee-bearing devnet mint.

## Program architecture (`program/act-presale/`)

Anchor 0.30.1, mirrors `act-staking`'s conventions (same `anchor_spl::token_interface` usage, same balance-delta fee handling, same PDA/`has_one` authority style).

**Accounts**
- `PresaleConfig` — singleton, PDA seeds `[b"presale_config"]`. Authority, `act_mint`/`act_vault`/`treasury_act_account`, index-matched `accepted_mints`/`accepted_vaults`/`treasury_payment_accounts` arrays (`[USDC, USDT]`), price, window, caps, vesting config, running totals (`total_raised_payment`, `total_act_sold_net`, `total_act_claimed_net`, `act_reserve_net`), `status` (0=Active, 1=Finalized, 2=Refunding), `paused`.
- `BuyerAccount` — PDA seeds `[b"presale_buyer", buyer_pubkey]`. Owner, per-currency `payment_contributed`/`refunded` arrays (index-matched to `accepted_mints`), net ACT allocated, net ACT claimed so far.

**Instructions**
- `initialize_presale` — one-time setup, authority-gated, creates config + the ACT vault ATA only. Moves no tokens.
- `initialize_payment_currency(index)` — authority-gated, called once per accepted currency (0=USDC, 1=USDT), registers that mint/vault/treasury-account and creates its vault ATA. Split out from `initialize_presale` because folding all three `init`+ATA constraints into one instruction overflows the SBF VM's 4096-byte stack-frame limit — see the code's own doc comment.
- `fund_act_reserve` — authority-gated, tops up the ACT vault (balance-delta recorded).
- `buy` — public, validates window/pause/min-first-buy/max-cumulative/hard-cap against whichever accepted currency (USDC or USDT) the caller passes, escrows payment token, computes and records net ACT entitlement.
- `buy_with_sol` — public; prices a native-SOL contribution against a live Pyth SOL/USD price update the caller supplies, folds the USD-equivalent into the same combined min-buy/max-buy/hard-cap accounting as USDC/USDT, escrows the lamports directly on `vault_authority`.
- `refund_sol` — buyer-callable under `Refunding`; mirrors `refund` but returns exact lamports paid, never re-priced.
- `finalize` — authority-gated, after window close or hard cap hit. Soft cap met: sweeps both currencies' escrow vaults to their treasury accounts, sets `tge_ts = now`. Soft cap missed: flips to `Refunding`, moves nothing.
- `refund` — buyer-callable under `Refunding`, once per currency the wallet used, returns exactly what that wallet put in for that currency.
- `claim` — buyer-callable under `Finalized`, past TGE. Pays out newly-vested net ACT, grossed up per the section above.
- `sweep_unsold_act` — authority-gated, after `Finalized`, reclaims vault ACT beyond what's still owed.
- `set_paused` / `set_config_authority` — admin controls.

**Authority:** the same Squads multisig already used for treasury and fee-config, not a new single key — consistent with the rest of the protocol's admin model.

## Verified on devnet

- **Core lifecycle** — `initialize_presale`, `initialize_payment_currency` (both currencies), `fund_act_reserve`, `buy` (USDC and USDT), `finalize` on hard-cap-reached (sweeps to the real Squads treasury ATAs), `claim` at TGE plus partial linear vesting. All confirmed via on-chain reads, not just transaction success.
- **Soft-cap-missed path** — `buy`, `finalize` into `Refunding`, `refund` returns exactly what was put in per currency, a second refund attempt correctly rejected.
- **Multi-checkpoint linear vesting** — four `claim` calls across a fast-clock vesting window (a `test-fast-clock` feature used only for this kind of time-dependent devnet testing, never for a devnet/mainnet deployment), cumulative claimed amount correct at each checkpoint, exact final total with nothing left over, a further claim correctly rejected once fully vested.
- **Native SOL support (`buy_with_sol`/`refund_sol`)** — a real, live Pyth SOL/USD price update posted on-chain and consumed by `buy_with_sol`, with the resulting USD-equivalent accounting matching the live price to the sub-cent; `refund_sol` returns exactly the lamports contributed, with a second refund attempt correctly rejected.
- **DEX/AMM Token-2022 compatibility** — researched and proven with real devnet swaps. All three major Solana AMMs support `TransferFeeConfig` natively, no whitelist/badge needed:
  - **Raydium**: CPMM has full Token-2022 transfer-fee support; CLMM supports it via the explicit `SwapV2` accounts (not the legacy `Swap` instruction). **AMM v4 does not support Token-2022 at all** — avoid v4 for ACT pools. Raydium computes curve math on the post-fee amount and checks slippage against the pool's gross obligation, not the end-user's net receipt, so a fee-rate change between quote and execution doesn't break a trade. ([Raydium docs](https://docs.raydium.io/algorithms/token-2022-transfer-fees))
  - **Orca**: Whirlpools support the `TransferFee` extension with **no Token Badge required** (badges are only needed for `PermanentDelegate`, `TransferHook`, `MintCloseAuthority`, `DefaultAccountState`, `FreezeAuthority`). ([Orca docs](https://docs.orca.so/create/pools/extensions))
  - **Meteora**: Both DLMM and DAMM v2 support Token-2022 mints with the transfer-fee extension permissionlessly (no `token_badge` needed for transfer-fee + metadata-pointer specifically). ([Meteora DLMM docs](https://docs.meteora.ag/overview/products/dlmm/token-2022-extensions), [DAMM v2 repo](https://github.com/MeteoraAg/damm-v2))
  - ACT's uncapped `maximum_fee` (u64::MAX) sidesteps the one caveat these docs raise: Raydium's fee-cap saturation behavior on very large trades — with no cap, ACT always pays the full 350 bps regardless of size, so there's no saturation edge case to reason about.
  - **Raydium**: created a real CPMM pool (`DwhXfWKGbs92NrhpFY7bXH9zzcGjNHX7kNvrsThM8aUj`, on Raydium's real devnet program `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`) pairing test-ACT against test-USDC, seeded with initial liquidity, and executed a real swap through it. Confirmed straight from the confirmed transaction's own token balances: the withheld amount matched the mint's real fee rate to the basis point (350 bps exactly). Raydium's CPMM sends the pool's computed gross amount via a normal `TransferChecked` and lets the mint's own extension logic withhold the fee, the same balance-delta-safe approach this program itself uses. See `scripts/exercise-devnet-raydium-cpmm.mjs`.
  - **Orca**: created a real Orca Whirlpool "splash pool" (`3kY8x7mnxKKcUHmDnfLJ1M8Yv6G8NQ7K8LKkbEb8C4Eo`, on Orca's real devnet deployment — the Whirlpool program is deployed at the *same* address on devnet and mainnet, `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`) pairing the same test-ACT against test-USDC, opened a full-range position, and swapped. The implied fee on the ACT leg landed at exactly 350 bps, same as Raydium's result. See `scripts/exercise-devnet-orca-whirlpool.mjs`.
  - **Meteora**: created a real Meteora DAMM v2 pool (`GobTxZ9CqYpDTBVKxCpZK5iEob7WxBucybyt7Q3PHBBv`, via `createCustomPool` on Meteora's real devnet deployment — the CP-AMM program is deployed at the *same* address on devnet and mainnet, `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) pairing the same test-ACT against test-USDC, seeded a full-range position, and swapped. The implied fee landed at exactly 350 bps again — the third independent AMM to confirm this to the basis point. See `scripts/exercise-devnet-meteora-damm.mjs`.
  - **Real-ACT mainnet check** — a real, un-sent Raydium CPMM `createPool` instruction was built against the *real* ACT mint (`7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG`) and *real* USDC on mainnet, and checked via `connection.simulateTransaction` (no signers, nothing broadcast or persisted) — the one thing devnet testing couldn't check, since the real mint has an extra `MetadataPointer` extension the devnet test-ACT mint doesn't. Simulated "as" the real Squads treasury vault (which holds the entire real ACT supply), with no private key used or needed. The real ACT-side deposit transfer (`TransferChecked` on Token-2022, subject to the mint's real 350 bps `TransferFeeConfig` and its `MetadataPointer` extension) executed successfully; a follow-up simulation using the vault's real (small) USDC balance confirmed the USDC-side transfer and pool/vault account creation succeed too, stopping only on the real SOL needed for the last account's rent — a funding fact, not a compatibility gap. See `scripts/simulate-mainnet-raydium-real-act.mjs` and `scripts/simulate-mainnet-raydium-real-act-final.mjs`.
  - **Still open**: no AMM pool has actually been *created* with real ACT — that would spend real funds seeding real liquidity and is a separate decision from proving the mechanism works, not attempted here. AMM v4 remains confirmed unusable for Token-2022 regardless.

## Deployment sequence

1. Compile + fix (this repo's `cargo check` / `anchor build`).
2. Devnet deploy, using a devnet-only ACT-like Token-2022 mint with the same 3.5% fee config, and devnet USDC. **Done.**
3. Exercise every instruction above end to end on devnet, unit + integration tests. **Done** — see "Verified on devnet" above.
4. Independent security review. **Done.**
5. **Explicit, separate approval before mainnet deployment or before this program ever touches the real ACT mint or real funds.**
