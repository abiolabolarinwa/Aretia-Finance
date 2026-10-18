# Trading Aretia tokens outside Aretia

Status: **nothing here is live.** The Aretia Pool program is unaudited and exists on devnet only. This is the checklist and the pack to hand to the parties who decide whether outside apps can trade it. Written 2026-10-18.

## What already works outside Aretia

A token opened with a **Meteora DAMM v2 pool** (the Launch page's original flow) is routed today by Jupiter, shown by Phantom's swap, and indexed by DexScreener, GeckoTerminal and Birdeye. Nothing is needed from us. If a creator wants the token traded outside Aretia now, that is the pool to open. The curve's existing graduation opens exactly that pool.

An **Aretia Pool** is traded on Aretia only: our own router (Swings) knows how to price and build swaps for it (disabled until audit), and nobody else does yet.

The cost of choosing the Aretia Pool is that Aretia, not Meteora, earns the protocol fee share, but outside apps cannot see it. Both can exist for the same token (liquidity is then split and bots arbitrage the gap). The Launch card says this next to the form.

## 1. The pool the outside world already routes

Offer it first, keep it the default for creators who want outside reach. No work.

## 2. Jupiter (and other routers) routing the Aretia Pool

Who decides: Jupiter. It adds an AMM through its own integration process; we cannot add ourselves. Expect them to ask for: a mainnet program id; an independent audit; a public IDL; an adapter in their `jupiter-amm-interface` format; and some live liquidity. They also add a variant to their `Swap` enum and their on-chain router, which is theirs to do.

**Built and tested (devnet program, nothing submitted):**
* **Wrapped SOL.** Since v4 the pool's SOL side is a wrapped-SOL token account (the pool's associated account for the native mint) and the swap takes the trader's wrapped-SOL account, so a router's ordinary wrap and unwrap of SOL works. This was the one thing a router could not do with the earlier native-SOL pool.
* **The adapter** `program/aretia-pool/jupiter-amm` (Rust, `jupiter-amm-interface` 1.0.0-beta.0, 5 tests): parses the pool account, quotes exactly with `pool-math` at the fee in force now (including the creator's launch schedule), and returns the swap's account list for both directions. `Swap::TokenSwap` in it is a PLACEHOLDER; Jupiter assigns the real variant.
* **The IDL** `program/aretia-pool/idl/aretia_pool.json`, checked by a test against the program source and the web builders, so it cannot drift.
* **Pool discovery**: the pool address is the PDA `["pool", mint]`, so a router finds a token's pool from the mint with no index.
* **Swap layout**: tag, `is_buy: bool`, `amount_in: u64`, `min_out: u64`; accounts: trader (signer), pool, SOL vault, mint, token vault, trader token, trader wrapped SOL, Aretia's wrapped-SOL fee account, Token-2022, Token program.

**Not built, and not buildable by us:** the submission, the audit, a mainnet program id, and Jupiter's own router variant.

## 3. Make the token look legitimate

* Name, symbol and a metadata link are stored in the token's own Token-2022 metadata. The link must point at a stable JSON file with an image. Without a logo, wallets and explorers show a blank token.
* **Built (`website/src/scripts/walletTokenMetadata.ts`, 22 tests):** builds the standard metadata JSON from what a creator types (name, symbol, description, logo link, optional website, X, Telegram) with exact problems named; checks a hosted file against its token (logo present, name and symbol match, description present); and, from the mint alone, tells the pool's review screen when a token has no metadata link or a link wallets will not load. The Aretia Pool review now shows those notes before any money is spent.
* **Not built: hosting.** Running storage for creators' files and images on Aretia's side means cost, an upload surface to abuse and moderation, which are the owner's decisions. Until then the creator hosts the JSON (IPFS or their site) and pastes its link into the Launch form. Suggested first step if wanted: IPFS pinning through a paid pinning service with a size cap, files limited to the JSON and one image of at most 1 MB, the account key held server-side only.
* Verification: Jupiter marks tokens "verified" only through its own process (a community-token request with the project's links and liquidity). Phantom and others warn on unverified, new, thinly traded tokens regardless of how they were made. The token is fixed-supply with no freeze or mint authority, which is what these reviews look for; the request can say so.

## 4. Make the pool visible to trackers

DexScreener and GeckoTerminal index pools of programs they have added. For an Aretia Pool they need, per pool: program id, pool address, the two mints, current reserves, and swap events with amounts, trader and time. Everything is available:
* Events (`Created`, `Swapped`, `LiquidityChanged`, `Claimed`, `Locked`, `RecipientSet`, `PositionTransferred`) are in the IDL.
* **Reserves are now readable from the vaults like any other pool:** the token vault and the SOL vault (the pool's wrapped-SOL account) are ordinary token accounts, so a tracker can read their balances. Note the price is not simply vault ratio: it is `(y + l) / (x + vx)` from the pool account (`y`, `l`, `x`, `vx` are in the IDL's `Pool`), because `l` and `vx` are virtual. A tracker that uses vault balances alone will misstate the price of a pool with a ceiling or a single-sided start; the pack must say so.
* Liquidity (TVL): the real SOL `y` plus the token side `x` at that price. `l` and `vx` are virtual and are not money.
* Fee: `fee_bps` (base) and the schedule in `fee_start_bps`, `decay_secs`, counted from `created_at`.

A request to each tracker needs the same pack plus a mainnet pool to look at, so it waits for deployment. Until then Aretia's own Radar charting reads these pools directly.

## Order of work

1. Done: Meteora stays the outside-visible default and the card says so; wrapped-SOL pool (v4); Jupiter adapter and IDL; metadata builder, checker and review notes.
2. Mainnet deployment of the pool under its own program id, treasury multisig as upgrade authority, after an audit.
3. Submit to Jupiter and the trackers with the pack above.
4. Hosted metadata and logo for creators, after the owner decides on storage and moderation (can be built without waiting for any of the above).
