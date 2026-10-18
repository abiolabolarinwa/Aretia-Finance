# Trading Aretia tokens outside Aretia

Status: **nothing here is live.** The Aretia Pool program is unaudited and exists on devnet only. This is the checklist and the pack to hand to the parties who decide whether outside apps can trade it. Written 2026-10-18.

## What already works outside Aretia

A token opened with a **Meteora DAMM v2 pool** (the Launch page's original flow) is routed today by Jupiter, shown by Phantom's swap, and indexed by DexScreener, GeckoTerminal and Birdeye. Nothing is needed from us. If a creator wants the token traded outside Aretia now, that is the pool to open. The curve's existing graduation opens exactly that pool.

An **Aretia Pool** is traded on Aretia only: our own router (Swings) knows how to price and build swaps for it (disabled until audit), and nobody else does yet.

The cost of choosing the Aretia Pool is that Aretia, not Meteora, earns the protocol fee share, but outside apps cannot see it. Both can exist for the same token (liquidity is then split and bots arbitrage the gap). The Launch card says this next to the form.

## 1. The pool the outside world already routes

Offer it first, keep it the default for creators who want outside reach. No work.

## 2. Jupiter (and other routers) routing the Aretia Pool

Who decides: Jupiter. It adds an AMM through its own integration process; we cannot add ourselves. Expect their team to ask for: a mainnet program id; an independent audit; a public IDL; an adapter in their `jupiter-amm-interface` format; and some live liquidity. They may also need to add a swap variant to their on-chain router, which is theirs to do.

What we can hand them today (all in this repo):
* Program, accounts, instructions and events: `program/aretia-pool/idl/aretia_pool.json` (hand-written; a test checks it against the program and the web builders, so it cannot drift).
* The exact quote maths with no Solana dependency: `program/aretia-pool/pool-math` (Rust, property-tested). An adapter's `quote` is `pool_math::buy` / `pool_math::sell` on the pool account's fields, using the fee in force now (`effective_fee_bps`, which includes the creator's launch schedule).
* Swap instruction layout and account order: `docs/ARETIA_POOL.md` section 4 and the IDL. The pair is always (token, **native SOL**). Native SOL is the one thing a router will want changed: either a wrapped-SOL variant of the pool or an adapter that wraps and unwraps around the swap.
* Pool discovery: the pool address is the PDA `["pool", mint]` under the program, so a router can find a token's pool from the mint with no index.

What we still have to build before approaching them: a mainnet deployment (own program id, upgrade authority to the treasury multisig), the audit, and, if they ask, the wrapped-SOL variant. None can be started honestly before the audit decision.

## 3. Make the token look legitimate

* Name, symbol and a metadata link are already stored in the token's own Token-2022 metadata. The Launch form has a metadata link field (https or ipfs). **The link must point at a stable JSON file with an image** (standard token-metadata JSON: name, symbol, description, image). Without a logo, wallets and explorers show a blank token.
* Hosting: the Launch page should offer to host that JSON and logo for the creator (IPFS pinning or Aretia storage). Not built. Until then creators supply their own.
* Verification: Jupiter marks tokens "verified" only through its own process (a community-token request, with the project's links and liquidity). Phantom and others warn on unverified tokens that have little liquidity and a new mint; that warning is theirs and will show regardless of how the token was made. The token is fixed-supply with no freeze or mint authority, which is what these reviews look for; we can say so in the request.

## 4. Make the pool visible to trackers

DexScreener and GeckoTerminal index pools of programs they have added. For an Aretia Pool they need, per pool: program id, pool address, the two mints, current reserves, and swap events with amounts, trader and time. Everything is available:
* Events (`Created`, `Swapped`, `LiquidityChanged`, `Claimed`, `Locked`, `RecipientSet`, `PositionTransferred`) are in the IDL.
* Reserves: `x + vx` tokens and `y + l` SOL (the effective reserves; a plain `x`, `y` would misstate the price of a pool with a ceiling). Price is `(y + l) / (x + vx)` in lamports per raw token unit.
* Liquidity (TVL) for a tracker: the real SOL `y` plus the token side `x` at that price. `l` and `vx` are virtual and are not money.
* Fee: `fee_bps` (base) and the schedule in `fee_start_bps`, `decay_secs`, counted from `created_at`.

A request to each tracker needs the same pack plus a mainnet pool to look at, so it also waits for deployment. Until then Aretia's own Radar charting reads these pools directly.

## Order of work

1. Now: keep Meteora as the outside-visible default; say so on the card (done).
2. Mainnet deployment of the pool under its own program id, treasury multisig as upgrade authority, after an audit.
3. Submit to Jupiter and the trackers with the pack above.
4. Hosted metadata and logo for creators (can be built without waiting for any of the above).
