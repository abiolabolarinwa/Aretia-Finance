# ACT Public Presale — Design Record

**Status (updated 18 Sept 2026):** Deployed and exercised on devnet at `5hmgnujNib14NDkEgRsLpY3H8SBDCsLryiymNKY6fWku`. **Devnet only. Not deployed to mainnet.** No mainnet deployment without a separate, explicit go-ahead — see "Deployment sequence" below.

A full devnet run (init both payment currencies, fund the ACT reserve, two buys in USDC and USDT, finalize, claim, attempted sweep) has been exercised end to end using throwaway test-ACT/test-USDC/test-USDT mints, with the treasury destinations wired to the **real mainnet Squads vault** (`GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA`) — devnet ATAs owned by that address, which has no signing authority on devnet, so nothing could be spent from them; the point was only to prove `finalize`/`sweep_unsold_act` route to the correct address, which it does (confirmed: both $20 test buys landed in the treasury ATAs after `finalize`).

That exercise caught and fixed two real bugs before either could touch real value:
1. **`Claim`'s `config` account wasn't marked `mut`.** Anchor only persists account mutations back on-chain for accounts marked `mut`; `claim()` wrote `config.total_act_claimed_net` but the struct didn't mark `config` as writable, so that counter would have silently failed to update on every claim, corrupting `sweep_unsold_act`'s accounting. Fixed by adding `mut` to `Claim`'s `config` constraint.
2. **`grossed_up_amount` was using the wrong SPL Token-2022 method.** `TransferFeeConfig::calculate_inverse_epoch_fee` returns the *fee* that would be withheld to net a given amount, not the *gross (pre-fee) amount* to transfer — confirmed by reading `spl-token-2022`'s actual source. The program was sending roughly just the fee portion (~3.6% of what was needed at 350 bps) instead of the full gross amount, which a real devnet `claim` call caught immediately (`GrossUpShortfall`). Fixed by switching to `TransferFee::calculate_pre_fee_amount` (via `get_epoch_fee`), which is the actual inverse function. `claim` also now retries with a balance-delta-sized top-up (bounded at 4 iterations) to absorb any small residual rounding, and `sweep_unsold_act` adds a small fixed safety margin to its "still owed" estimate — both defenses in depth against `calculate_pre_fee_amount`'s stated approximation behavior under rounding, not against the (now-fixed) order-of-magnitude bug itself.

This is exactly the kind of thing the "needs a real devnet transfer" open item below was flagging — it would have been a serious, silent shortfall against every claim on mainnet.

**Legal status:** `ATTORNEY_BRIEF.md` §4 Q6 was scoped against "no presale or private offering planned." Counsel's 1 Sept 2026 approval of the entity structure and securities framing was given on that premise, not against a presale. Per this project's own confirmation, legal has since reviewed and cleared proceeding with a presale under this structure. That clearance should be treated the same way the two prior addenda in `ATTORNEY_BRIEF.md` (management-fee increase, registration-fee mechanism) are treated: recorded as its own dated note, not folded silently into the original brief.

**Independent security review:** confirmed by the project owner (18 Sept 2026) as done/cleared. Recorded here as self-reported, per this file's own convention for legal/review sign-offs — not independently re-verified by this session.

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
| Payment token | USDC and USDT (both accepted; index-matched arrays in config), plus SOL via `buy_with_sol` (priced live against Pyth's SOL/USD pull oracle). |
| Liquidity target | 80% of net proceeds, scaling with actual raise, not a fixed dollar promise |

## The two-hop fee problem, and how this program handles it

Vesting requires ACT to sit in a program-owned vault between "sold" and "claimed." That's two fee-bearing transfers per token, not one:

1. **Funding the vault** (`fund_act_reserve`): treasury → vault. Loses 3.5%.
2. **Paying out a claim** (`claim`): vault → buyer, at each vesting release. Loses 3.5% again.

Naively reserving the doc's original single-hop estimate (100M / 0.965 ≈ 103.6M gross) only covers hop 2. To land 100M net after *both* hops compounding (0.965² ≈ 0.931), the treasury-side send for `fund_act_reserve` needs to be closer to **100M / 0.965² ≈ 107.4M ACT**, which lands roughly 103.6M net in the vault after hop 1 — matching the doc's number, but as the amount available for hop 2, not the treasury-side send.

Rather than hardcode 3.5% anywhere (governance could recalibrate it — see `MINT_V2.md`), this program:

- Tracks every buyer's entitlement in **net** terms only (`BuyerAccount.act_allocated_net`).
- Funds the vault using the **balance-delta** pattern already established in `act-staking`'s `stake` (read the vault's balance before/after the CPI, trust that delta) — correct regardless of the fee rate at call time.
- At claim time, reads the ACT mint's live `TransferFeeConfig` extension and calls `TransferFee::calculate_pre_fee_amount` (via `get_epoch_fee`) to work out the gross amount to send so the buyer nets (at least) their vested entitlement, verified again via balance-delta after the transfer, with a bounded top-up retry if the estimate falls short. This is the same "how much do I send so the recipient nets X" problem the whitepaper's §14.5 management-fee gross-up already solves, applied here per-claim instead of once.
- `sweep_unsold_act` lets the authority reclaim whatever's left in the vault beyond what's still owed (with a small fixed safety margin on the "still owed" estimate), once the sale is finalized — so an under-hard-cap raise doesn't strand ACT in the vault indefinitely.

**Proven correct by a real devnet transfer** (18 Sept 2026) — see the status note at the top of this file for the bug that first attempt caught (`calculate_inverse_epoch_fee` returns the fee, not the gross amount) and the fix.

## Program architecture (`program/act-presale/`)

Anchor 0.30.1, mirrors `act-staking`'s conventions (same `anchor_spl::token_interface` usage, same balance-delta fee handling, same PDA/`has_one` authority style).

**Accounts**
- `PresaleConfig` — singleton, PDA seeds `[b"presale_config"]`. Authority, `act_mint`/`act_vault`/`treasury_act_account`, index-matched `accepted_mints`/`accepted_vaults`/`treasury_payment_accounts` arrays (`[USDC, USDT]`), price, window, caps, vesting config, running totals (`total_raised_payment`, `total_act_sold_net`, `total_act_claimed_net`, `act_reserve_net`), `status` (0=Active, 1=Finalized, 2=Refunding), `paused`.
- `BuyerAccount` — PDA seeds `[b"presale_buyer", buyer_pubkey]`. Owner, per-currency `payment_contributed`/`refunded` arrays (index-matched to `accepted_mints`), net ACT allocated, net ACT claimed so far.

**Instructions**
- `initialize_presale` — one-time setup, authority-gated, creates config + the ACT vault ATA only. Moves no tokens.
- `initialize_payment_currency(index)` — authority-gated, called once per accepted currency (0=USDC, 1=USDT), registers that mint/vault/treasury-account and creates its vault ATA. Split out from `initialize_presale` because folding all three `init`+ATA constraints into one instruction overflowed the SBF VM's 4096-byte stack-frame limit — see the code's own doc comment.
- `fund_act_reserve` — authority-gated, tops up the ACT vault (balance-delta recorded).
- `buy` — public, validates window/pause/min-first-buy/max-cumulative/hard-cap against whichever accepted currency (USDC or USDT) the caller passes, escrows payment token, computes and records net ACT entitlement.
- `buy_with_sol` — public; prices a native-SOL contribution against a live Pyth SOL/USD price update the caller supplies, folds the USD-equivalent into the same combined min-buy/max-buy/hard-cap accounting as USDC/USDT, escrows the lamports directly on `vault_authority`.
- `refund_sol` — buyer-callable under `Refunding`; mirrors `refund` but returns exact lamports paid, never re-priced.
- `finalize` — authority-gated, after window close or hard cap hit. Soft cap met: sweeps both currencies' escrow vaults to their treasury accounts, sets `tge_ts = now`. Soft cap missed: flips to `Refunding`, moves nothing.
- `refund` — buyer-callable under `Refunding`, once per currency the wallet used, returns exactly what that wallet put in for that currency.
- `claim` — buyer-callable under `Finalized`, past TGE. Pays out newly-vested net ACT, grossed up per the section above.
- `sweep_unsold_act` — authority-gated, after `Finalized`, reclaims vault ACT beyond what's still owed.
- `set_paused` / `set_config_authority` — admin controls. `set_config_authority` shipped from day one this time; `act-staking` had to add it after the fact.

**Authority:** recommend the same Squads multisig already used for treasury and fee-config, not a new single key — consistent with the rest of the protocol's admin model.

## Open items (block mainnet, not devnet)

1. ~~**`calculate_inverse_epoch_fee` correctness**~~ — **Resolved 18 Sept 2026.** A real devnet transfer caught a real bug (wrong SPL method; see status note above), now fixed and confirmed working via `claim` on devnet.
2. ~~**DEX/AMM Token-2022 compatibility**~~ — **Resolved 18 Sept 2026.** Researched, then proven with a real devnet swap. All three major Solana AMMs support `TransferFeeConfig` natively, no whitelist/badge needed:
   - **Raydium**: CPMM has full Token-2022 transfer-fee support; CLMM supports it via the explicit `SwapV2` accounts (not the legacy `Swap` instruction). **AMM v4 does not support Token-2022 at all** — must avoid v4 for ACT pools. Raydium computes curve math on the post-fee amount and checks slippage against the pool's gross obligation, not the end-user's net receipt, so a fee-rate change between quote and execution doesn't break a trade. ([Raydium docs](https://docs.raydium.io/algorithms/token-2022-transfer-fees))
   - **Orca**: Whirlpools support the `TransferFee` extension with **no Token Badge required** (badges are only needed for `PermanentDelegate`, `TransferHook`, `MintCloseAuthority`, `DefaultAccountState`, `FreezeAuthority`). ([Orca docs](https://docs.orca.so/create/pools/extensions))
   - **Meteora**: Both DLMM and DAMM v2 support Token-2022 mints with the transfer-fee extension permissionlessly (no `token_badge` needed for transfer-fee + metadata-pointer specifically). ([Meteora DLMM docs](https://docs.meteora.ag/overview/products/dlmm/token-2022-extensions), [DAMM v2 repo](https://github.com/MeteoraAg/damm-v2))
   - ACT's uncapped `maximum_fee` (u64::MAX) sidesteps the one caveat these docs raise: Raydium's fee-cap saturation behavior on very large trades — with no cap, ACT always pays the full 350 bps regardless of size, so there's no saturation edge case to reason about.
   - **Proven on devnet**: created a real Raydium CPMM pool (`DwhXfWKGbs92NrhpFY7bXH9zzcGjNHX7kNvrsThM8aUj`, on Raydium's real devnet program `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`) pairing test-ACT (Token-2022, the same 350 bps transfer-fee mint used throughout devnet testing) against test-USDC, seeded with initial liquidity, and executed a real swap through it. Confirmed straight from the confirmed transaction's own token balances: the pool's ACT vault sent 128,708,567,380 raw units (gross); the swapper's wallet increased by 124,203,767,521 (net) — a withheld amount that is **exactly 350 bps** of the gross, matching the mint's real fee rate to the basis point. Raydium's CPMM handles the transfer-fee mint correctly: it sends the pool's computed gross amount via a normal `TransferChecked`, and lets the mint's own extension logic withhold the fee, the same balance-delta-safe approach this program itself uses. (One practical lesson from doing this for real: the first swap attempt used a 1% slippage tolerance and failed with `ExceededSlippage`, because the off-chain `CurveCalculator` quote and the actual on-chain result differed by roughly 1-2% — a real reminder that an off-chain quote is an estimate, not a guarantee, and production tooling should not assume tight slippage bounds are safe for a transfer-fee mint.) See `scripts/exercise-devnet-raydium-cpmm.mjs`.
   - **Still open**: this used Raydium's SDK against real devnet program addresses with throwaway test tokens — it has not been tried against the real ACT mint, and CLMM/Whirlpools/Meteora were researched but not exercised the same way. AMM v4 remains confirmed unusable for Token-2022 regardless.
3. ~~**SOL payment support**~~ — **Resolved 18 Sept 2026.** `buy_with_sol` is implemented for real (no longer a stub) and proven against a real, live Pyth price update on devnet:
   - **Oracle**: Pyth's pull-oracle model. `SOL_USD_FEED_ID` is a fixed 32-byte feed ID (not an account address -- price-update accounts are ephemeral under this model), confirmed live against Pyth's own Hermes API and cross-checked against `pyth-solana-receiver-sdk`'s own doc-comment/test fixture for the same hex string. The caller supplies a `PriceUpdateV2` account (posted on-chain moments earlier via Pyth's receiver program, `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, confirmed live on both mainnet and devnet); this program validates it against that feed ID and rejects anything older than `MAX_PRICE_STALENESS_SECONDS` (60s) via `get_price_no_older_than`.
   - **Accounting**: SOL is escrowed as native lamports directly on the `vault_authority` PDA (no wrapping into wSOL, no separate vault) and swept/refunded via ordinary signed System Program transfers -- the same CPI-signing pattern every other `vault_authority` use in this program already relies on. Because SOL floats against USD (unlike USDC/USDT), each contribution is converted to a USD-equivalent at the live price (`lamports_to_payment_units`, generic over whatever `exponent` the feed reports, not hardcoded to the commonly-seen -8) and folded into the *same* combined `total_raised_payment`/min-buy/max-buy/hard-cap accounting the other two currencies already share. `BuyerAccount.sol_usd_value_contributed` tracks that USD-equivalent for cap purposes; `BuyerAccount.sol_lamports_contributed` separately tracks the exact lamports paid, so `refund_sol` returns precisely what was paid regardless of how the price has moved since.
   - **Proven on devnet**: posted a real live SOL/USD price update from Hermes ($112.28 at the time) and called `buy_with_sol` with 0.05 SOL in the same transaction sequence -- confirmed `vault_authority` received exactly 0.05 SOL, and `sol_usd_value_contributed` landed at $5.614053, matching 0.05 x $112.28 to the sub-cent. See `scripts/exercise-devnet-buy-with-sol.mjs`. Tested on a throwaway program deployment (closed and rent-reclaimed afterward), then redeployed to the primary devnet address.
   - **A real packaging mess, not a program bug**: getting the Pyth *JS* SDK (used only by this test script, not by the on-chain program) working in this environment took five separate fixes, none of them in this repo's own code: two broken ESM import paths inside `@pythnetwork/pyth-solana-receiver`'s dependency chain (`jito-ts` via `@pythnetwork/solana-utils`, and a bare directory import in a nested `@coral-xyz/anchor` copy) patched directly in `node_modules`; a version-incompatible nested `jito-ts` copy of `@solana/web3.js`/`rpc-websockets` deleted outright (forcing `jito-ts` onto the working top-level versions); and Pyth's Hermes price service starting to require an API key as of 26 Aug 2026 (a real, external, dated change -- worked around with a user-supplied key passed via `PYTH_API_KEY`, never committed). None of this touches the on-chain program; it only affects this one test script, and every patch lives outside version control (`node_modules` is gitignored) -- reinstalling dependencies from scratch will need these reapplied, or the JS SDK route re-debugged fresh.
   - **Still open**: only devnet-test amounts have been exercised (0.05 SOL); `refund_sol`'s success path specifically (as opposed to `buy_with_sol`'s) hasn't been separately exercised the way the USDC/USDT refund path was.
4. **`act-staking` devnet-deployment discrepancy** — **Resolved 18 Sept 2026.** The gap was real: `act-staking`'s README and this project's public website (`website/stake.html`) both stated "stake and unstake tested on devnet," but `unstake`'s actual success path (as opposed to its early-withdrawal *rejection*) had never been exercised -- the shortest lock is 30 real days, and a local-validator attempt to fast-forward that was tried and blocked by a documented native-Windows `solana-test-validator` genesis-unpacking failure (see `act-staking`'s README). Closed the same way this file's own vesting-checkpoint gap was closed: a throwaway devnet deployment (`Dk71i4rN8MmPFc1awfChRZigcso8DwBMLKwSGS5NW7ur`, built with `act-staking`'s own `test-fast-clock` feature, 2-second days) rather than a local validator. Staked 1000 test-ACT (Token-2022, 350 bps fee) for a 30-day lock (60 real seconds under the fast clock), confirmed the early-withdrawal rejection still works, waited for maturity, then called `unstake` again -- it succeeded, the wallet received exactly `965 * 0.965 ≈ 931.225` ACT (confirming the documented, deliberate lack of gross-up on withdrawal -- the staker eats both the deposit- and withdrawal-side fee, exactly as `act-staking`'s own code comment says), and the `user_stake` account closed with its rent refunded. 6/6 checks passed; see `act-staking/scripts/unstake-success-devnet-test.mjs`. The throwaway deployment has been closed and its rent reclaimed.
5. ~~**Full devnet exercise**~~ — **Resolved 18 Sept 2026.** Happy path (buy both currencies → finalize on hard-cap-reached → sweeps to the real Squads treasury ATAs → claim TGE + partial linear vesting), the soft-cap-missed path (buy → finalize → `Refunding` → `refund` returns exactly what was put in → a second refund attempt correctly rejected with `AlreadyRefunded`, on a second throwaway program deployment since `presale_config` is a per-deployment singleton PDA), and multi-checkpoint linear vesting (four `claim` calls across a 60-second fast-clock vesting window, cumulative claimed amount tracked correctly at each checkpoint, exact final total with nothing left over, further claim correctly rejected with `NothingClaimable`) are all exercised and passing. The vesting test used a third throwaway deployment built with the `test-fast-clock` feature (2-second days) — matching `act-staking`'s established precedent of testing this feature through a throwaway devnet deployment rather than a local validator, since `solana-test-validator` has a documented native-Windows genesis-unpacking failure in this environment. All three throwaway program deployments (refund test, vesting test, and an earlier failed-deploy leftover) have been closed and their rent reclaimed; only the primary devnet deployment remains live.
6. ~~**Independent security review**~~ — **Confirmed by the project owner, 18 Sept 2026.** Self-reported, per the same convention as the legal-status note above — not independently re-verified by this session. Worth remembering that this session's own devnet exercises already caught two real bugs on their own (a silent on-chain persistence bug and a gross-up math bug using the wrong SPL Token-2022 method), so whatever review took place had real, non-hypothetical risk to check for.

## Deployment sequence

1. Compile + fix (this repo's `cargo check` / `anchor build`).
2. Devnet deploy, using a devnet-only ACT-like Token-2022 mint with the same 3.5% fee config, and devnet USDC.
3. Exercise every instruction above end to end on devnet, unit + integration tests.
4. Independent security review.
5. **Explicit, separate approval before mainnet deployment or before this program ever touches the real ACT mint or real funds.**
