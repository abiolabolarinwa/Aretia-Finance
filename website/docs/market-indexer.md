# Aretia Market Indexer: operations

Architecture and decisions: [market-indexer-architecture.md](market-indexer-architecture.md). API: [market-indexer-api.md](market-indexer-api.md).

## What is running, and what it is evidenced by

| Level | Meaning |
|---|---|
| `live-verified` | the real engine ran against a live public node and passed (`src/swings/mi/engine.live.ts`, `npm run test:live`) |
| `fixture-tested` | creation and swap decoders pass on real logs captured from that DEX's factory (`src/swings/mi/fixtures/real-logs.json`, refreshed by `node scripts/capture-mi-fixtures.mjs > real-logs.new.json`), and a swap prices plausibly |
| `address-verified` | the factory address was confirmed on chain; no log of that DEX has been decoded yet |
| `planned` | not built |

The current table is returned live by `GET /api/v1/status` and is the source of truth; `src/swings/mi/dexes.ts` holds it. The
adapter that runs by default (`pancakeswap-v2-bnb`) is the one demonstrated end to end. Everything else is switched on by name
with `MI_ADAPTERS` once an operator is ready to carry its node load.

## Environment variables (server side only; none reaches the browser)

| Name | Purpose | Default |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | storage (already set for the site) | required |
| `MI_CRON_SECRET` | authorises `GET /api/mi-run`; when set it is the only secret accepted there, so the other schedules keep `CRON_SECRET` | falls back to `CRON_SECRET` |
| `ADMIN_WALLETS`, `SWINGS_SESSION_SECRET` | owner controls (already set for the admin page) | required for controls |
| `MI_ADAPTERS` | comma list of adapter ids (EVM such as `uniswap-v3-base`, Solana `raydium-cpmm-solana`, `orca-whirlpool-solana`, `pumpswap-solana`), or `*` | the four live-verified adapters: `pancakeswap-v2-bnb`, `raydium-cpmm-solana`, `orca-whirlpool-solana`, `pumpswap-solana` |
| `MI_RPC_<CHAIN>` or `EVM_RPC_<CHAIN>` | a dedicated node URL (https) for a chain; tried before the public nodes. Solana: `MI_RPC_SOLANA` or the existing `SOLANA_RPC_URL` | public nodes |
| `MI_CONFIRMATIONS_<CHAIN>` | blocks to wait before trusting a log | ethereum 12, bnb 15, polygon 64, base 10 |
| `MI_ADDRESS_BATCH_<CHAIN>` | pool addresses per `getLogs` (public nodes allow 10) | 10 |
| `MI_FOLLOW_NEWEST`, `MI_FOLLOW_RECENT` | pools whose swaps are followed per adapter (newest created, most recently traded) | 100 each |
| `MI_MIN_LIQUIDITY_USD` | listing rule: minimum dollar liquidity where known | 500 |
| `MI_INACTIVE_AFTER_HOURS` | a pool with no trade for this long becomes inactive | 168 |
| `MI_TRADE_RETENTION_DAYS` | trades older than this are deleted | 30 |

`<CHAIN>` is `ETHEREUM, BNB, POLYGON, BASE, ROBINHOOD`. Robinhood Chain needs `supabase/migrations/0019_market_indexer_robinhood.sql` applied before `uniswap-v3-robinhood` is switched on.

## Deployment steps

1. Apply the migrations: `npm run db:migrate` (needs `DATABASE_URL`) or paste `supabase/migrations/0017_market_indexer.sql` and then `0018_market_indexer_solana.sql` into the Supabase SQL editor.
2. Set `MI_CRON_SECRET` on the site to a long random string (or rely on `CRON_SECRET`). Optionally set `MI_RPC_BNB` to a dedicated node.
3. Schedule the run every minute: paste `supabase/cron/market-indexer-every-minute.sql` (after replacing the secret) into the Supabase SQL editor. The Vercel Hobby cron is daily only, so it is not used.
4. Check `GET /api/v1/status`: the adapter should read `ok` within a few minutes, and `GET /api/v1/pools/new?chain=bnb` should list markets.
5. Switch on further adapters one at a time (`MI_ADAPTERS=pancakeswap-v2-bnb,uniswap-v3-bnb`), watching `lagBlocks`.
6. Nothing else changes for visitors: the wallet's Market gains two lists, **Index: new pairs** and **Index: trending**.

## Operating it

- A run is bounded to about 45 seconds and resumes from each adapter's checkpoint, so a missed or overlapping call loses and
  duplicates nothing. After downtime it catches up in order, chunk by chunk, over as many runs as it takes.
- `lagBlocks` in `/status` is how far behind the safe head an adapter is. A public node is slow (the live run needed about 150 s
  for 2,400 BNB blocks): for a busy chain use a dedicated node, or the lag will not close.
- Controls (owner only, audit-logged): disable or enable an adapter, pause or resume one market, queue a backfill of a block
  range, requeue a stuck job. A job whose worker died stays `running`; `requeue-job` resets it.
- Reorgs: each run compares the checkpoint block's hash with the node's. On a mismatch it walks back to the fork, deletes what it
  wrote above it, and re-reads. Logs are read only from blocks `confirmations` deep in the first place.

## Provider cost (estimates, not quotes)

Steady-state call volume of one EVM adapter that follows about 200 pools, run every minute: roughly 25 to 60 JSON-RPC calls a
minute (head, checkpoint block, one creation `getLogs`, about 20 swap `getLogs` batches of 10 addresses, a block read per block
holding a log, a few reserve reads), so about 35,000 to 85,000 calls a day per adapter. Public nodes cost nothing but throttle
and drop requests; a dedicated node plan is priced by the provider per call or compute unit, so the monthly cost depends on that
plan: check the provider's current price sheet before relying on a figure. Storage: a busy adapter writes on the order of tens of
thousands of trade rows a day (each a few hundred bytes), which is why trades are deleted after 30 days by default. These are
estimates from the live run and the engine's call pattern, not measurements over a month.

## Known limits (see also the final report)

- Swaps are followed for the 100 newest and 100 most recently traded pools of each adapter. A pool outside both sets is not updated until it trades again within them. Raise `MI_FOLLOW_NEWEST`/`MI_FOLLOW_RECENT` and `MI_ADDRESS_BATCH_*` with a dedicated node.
- Liquidity for V3 pools is the balance of the quote token held, not the in-range depth. For Uniswap V4 pools (one PoolManager holds every pool's tokens) it is the depth within 1% of the price, estimated from the active liquidity: an estimate of what the pool can serve near the current price, not total value locked.
- Uniswap V4 pools with hooks are indexed like any other, but a hooked pool can behave unlike its price suggests; the hooks address is stored.
- Dollar figures exist only for dollar-stablecoin quotes and for native-coin quotes when the chain's reference pool could be read; otherwise `null`.
- Solana: Raydium CPMM, Orca Whirlpools and PumpSwap are indexed. PumpSwap pools are found through the pump.fun migration authority, so only pools created by a pump.fun graduation appear, not a pool someone creates directly (that account is not named in Pump's documentation; it was found from its real mainnet transactions). Meteora (DAMM v2, DLMM, Dynamic Bonding Curve) is not indexed: no account only its pool creation touches is known, so finding its pools needs a streaming provider or a scan of the whole program's transaction stream. Raydium AMM v4/CLMM/LaunchLab and Orca beyond the pools created by Whirlpools' own fee tiers are not covered either. Solana adapters read finalized transactions from the pools they follow (a few dozen per adapter on public nodes, 3 requests at a time), have no block-range backfill, and a creation burst larger than 3 pages of 40 signatures between two runs is counted as `truncated` in health rather than hidden.
- A Solana token's name and symbol come from its Metaplex metadata account when it has one; a Token-2022 metadata extension is not read, so such tokens are listed without a name.
- Market cap and fully diluted value are not provided: no reliable on-chain supply/circulation rule is applied.

## DEX coverage after the V4 / Aerodrome / Solana additions

- **EVM:** PancakeSwap V2 and V3, Uniswap V2, V3 and **V4**, SushiSwap V2, ApeSwap V2, **Aerodrome (V2-style and Slipstream) on Base**. Velodrome (Optimism) is not indexed: Optimism is not one of the indexer's networks.
- **Solana, new pools found as they are created:** Raydium CPMM, Orca Whirlpools, PumpSwap (graduations), **Raydium AMM v4** (a few new pools a day).
- **Solana, joins when opened (no creation-only account is known, so new pools of these cannot be found without a streaming provider):** **Raydium CLMM, Meteora DLMM, DAMM v2, Dynamic Bonding Curve**. Their pool layouts come from the programs' published IDLs and were checked on live pools; once a pool is opened it is followed.
- A V3-style or Solana pool added on request keeps the history it was read for (24 hours, then deeper run by run); a pool the indexer finds at its creation has all of its history.
