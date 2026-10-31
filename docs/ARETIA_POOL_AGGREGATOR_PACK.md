# Aretia Pool: submission pack for aggregators and price trackers

Status: **ready to send once the four gates below are met. Nothing has been sent.** Written 2026-10-31. It builds on `ARETIA_POOL_INTEGRATION.md` (the background) and `ARETIA_POOL.md` (the program).

Who decides: Jupiter, DexScreener, GeckoTerminal and Birdeye. Each adds a program through its own process; Aretia cannot add itself. What Aretia can do is arrive with everything they ask for, and the sections below are that.

## The four gates (all must be true before anything is sent)

| # | Gate | Where it stands (2026-10-31) |
|---|---|---|
| 1 | The pool program is live on mainnet under its own program id, with the upgrade authority held by the treasury multisig | Not done. The owner deploys from their own wallet (`ARETIA_POOL.md` section 13; `scripts/pool-solana-mainnet.mjs verify` checks it). |
| 2 | An independent audit report exists and says what it covers | The owner reports an audit was done. The report has not been given to the developer and the docs still say UNAUDITED. Section "The audit line" below. |
| 3 | A real pool exists on mainnet with some liquidity and at least a few real trades | Not done. Every tracker asks to see one. |
| 4 | The Jupiter adapter and the IDL match the deployed program | Adapter: built, 5 tests pass (run 2026-10-31). IDL: checked by a test against the program source. Both must be re-checked against the mainnet build once its id is written in. |

## What to send (the pack)

Everything below is in the repository; none of it needs to be written again.

| Item | Where | Notes |
|---|---|---|
| Program id | the owner's mainnet deployment | `<MAINNET_PROGRAM_ID>`; verified with `scripts/pool-solana-mainnet.mjs verify`. |
| Source of the program | `program/aretia-pool` (Anchor 0.30.1) | Build must be reproducible from the audited commit: send the commit hash the audit named. |
| Public IDL | `program/aretia-pool/idl/aretia_pool.json` | Events: `Created`, `Swapped`, `LiquidityChanged`, `Claimed`, `Locked`, `RecipientSet`, `PositionTransferred`. |
| Jupiter AMM adapter | `program/aretia-pool/jupiter-amm` (`jupiter-amm-interface` 1.0.0-beta.0) | `Swap::TokenSwap` in it is a placeholder: Jupiter assigns the real variant. Jupiter will want it in their own repository format; licence terms are the owner's call. |
| Pool maths | `program/aretia-pool/pool-math` | Pure integer maths, property-tested; the adapter quotes with exactly this code. |
| Audit report | the owner's file | Link or PDF, with the audited commit. |
| This page | | The facts in the next section. |

## The facts a router or tracker needs

* **One pool per token.** The pool address is the PDA `["pool", mint]` under the program id, so the pool for any token is found from the mint alone, with no index.
* **Pair:** the token against wrapped SOL (`So1111...1112`). Since v4 the SOL side is the pool's own wrapped-SOL token account, so a router's ordinary wrap and unwrap works.
* **The token:** a Token-2022 token with a fixed supply, no mint authority, no freeze authority, and no extension beyond its name, symbol and metadata link. The program refuses any other token. A router must support Token-2022.
* **Swap instruction:** tag, `is_buy: bool`, `amount_in: u64`, `min_out: u64` (exact input, with a minimum output). Accounts: trader (signer), pool, SOL vault, mint, token vault, trader token account, trader wrapped-SOL account, Aretia's wrapped-SOL fee account, Token-2022 program, Token program, then up to four optional trailing accounts that open Aretia's fee account in the same transaction if a wallet has closed it.
* **Price is not the ratio of the two vault balances.** It is `(y + l) / (x + vx)` from the pool account, because `l` and `vx` are virtual reserves (they let a pool open with tokens only and set a price ceiling). A tracker that uses vault balances alone will misstate the price of a single-sided or ceilinged pool.
* **Liquidity (TVL):** the real SOL `y` plus the token side `x` valued at that price. `l` and `vx` are virtual and are not money.
* **Fee:** the base `fee_bps` (25 or 100, fixed at creation), plus an optional launch schedule (`fee_start_bps` falling in a straight line over `decay_secs` from `created_at`). The fee in force at any time is computed by `pool-math` and by the adapter; a router must quote with it, not with the base fee. 20% of each fee goes to Aretia's fee wallet on every trade; the rest accrues to liquidity providers.
* **Locked liquidity:** a position can be locked for good (`locked` shares can never be removed). There is no admin instruction: nobody can change the rules after deployment. The upgrade authority is the treasury multisig.

## The audit line

The public wording must say exactly what the report supports, and only that. When the report is in hand, replace the first status line of `ARETIA_POOL.md`, the Launch card's mainnet notice, and this pack with a sentence of this form, filled in from the report:

> Audited by `<firm>`, report dated `<date>`, covering `<program, commit hash>`. `<N>` findings: `<how many fixed / acknowledged / open>`. Report: `<link>`.

Do not write a bare "audited". The report must name the commit that is deployed; if the deployed build differs from it, say so.

## Draft messages

Placeholders are in angle brackets. Do not send until the four gates are met.

**To Jupiter (AMM integration)**

> Subject: New AMM for integration: Aretia Pool (Solana)
>
> We would like to integrate Aretia Pool, a constant-product pool for Token-2022 tokens against wrapped SOL, into Jupiter routing.
> Program id: `<MAINNET_PROGRAM_ID>`. Upgrade authority: `<multisig address>`. Audit: `<firm, date, link, commit>`.
> Pool discovery from the mint: PDA `["pool", mint]`. Quote: exact integer maths, with the fee in force at the current time (launch schedule included); code in `pool-math`. Adapter against `jupiter-amm-interface`: `<repository link>` (5 tests). IDL: `<link>`.
> Live pool for review: `<pool address>` (token `<mint>`), liquidity `<amount>`, `<N>` trades so far.
> We are happy to change the adapter to match your current interface. Contact: `<name, email>`.

**To DexScreener, GeckoTerminal and Birdeye (one message, adjusted)**

> Subject: Please index the Aretia Pool program (Solana)
>
> Program id `<MAINNET_PROGRAM_ID>`; IDL `<link>`; an example pool `<pool address>` for token `<mint>`.
> Per pool you need the two mints, the reserves and the swap events (`Swapped`: amounts, trader, time). Important for correct prices: price is `(y + l) / (x + vx)` from the pool account, because `l` and `vx` are virtual; vault balances alone give the wrong price for single-sided or ceilinged pools. TVL is real SOL `y` plus token side `x` at that price.
> Documentation: `<link to this page>`. Contact: `<name, email>`.

## After they say yes

* Flip the Swings venue (`website/src/swings/dex/entries.ts`, `aretia-pool`) from `DISABLED` to `ACTIVE` only with the audit, the mainnet deployment and `npm run test:live` coverage, as `ARETIA_POOL.md` section 14 says.
* Per the owner's decision of 2026-10-18, the Launch card keeps Meteora as the default pool until Jupiter routes the Aretia Pool, then it flips.
* Launch Box already reads a Meteora pool from the chain; give it a reader for Aretia pools (the adapter `website/src/swings/solana/aretiaPool.ts` already parses them) at the same time.

## What this pack cannot do

It cannot make any of them say yes, or say when. Jupiter's review, and the trackers' queues, are theirs. It also cannot stand in for the audit report or the mainnet deployment.
