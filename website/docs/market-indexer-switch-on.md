# Market Indexer: switching it all on

Written 2026-10-31. The indexer, its decoders and the chart/trades preference for it are built. What is left to turn it on is
configuration you do in your own accounts, plus two pieces of work that are not built (stated plainly at the end).

## What the code now does

- **Chart and trades prefer the indexer.** For a pool the indexer follows, the chart's candles (`/api/swings-ohlcv?source=aretia`) and the
  Transactions table (`/api/swings-trades`) come from trades stored from the chain. GeckoTerminal is read only for a pool the indexer does
  not follow, or for history older than the indexer's own. A pool it does not know is remembered for five minutes so it is not asked again.
  Dollar candles and trades exist only for pools quoted in a dollar stablecoin; other pools use the outside source as before.
- **The public status says why an adapter fails**: `GET /api/v1/status` now carries `lastError` and `failures` for a failing adapter
  (links and long tokens removed).
- **Robinhood Chain is indexed** (`uniswap-v3-robinhood`, decoded on real captured logs). It needs migration `0019` first.

## Steps, in order (each one is yours: they use your accounts)

1. **Paid nodes.** Create mainnet endpoints with a provider (Helius, QuickNode, Alchemy, Triton) for Solana, BNB Chain, Ethereum, Base,
   Polygon and Robinhood Chain (if the provider lists it; otherwise leave Robinhood on its public nodes). In Vercel (Production,
   Sensitive) set:
   - `SOLANA_RPC_URL` (also used by the site's own RPC proxy), or `MI_RPC_SOLANA`
   - `MI_RPC_BNB`, `MI_RPC_ETHEREUM`, `MI_RPC_BASE`, `MI_RPC_POLYGON`, `MI_RPC_ROBINHOOD`
   - optional, for a node that allows bigger `getLogs` batches: `MI_ADDRESS_BATCH_<CHAIN>` (public nodes allow 10; a paid node can take
     50 or more) and `MI_CONFIRMATIONS_<CHAIN>` if you want a different depth.
2. **Database.** In the Supabase SQL editor (or `npm run db:migrate`) apply `supabase/migrations/0019_market_indexer_robinhood.sql`.
   It is safe to run twice. Without it the Robinhood adapter's writes are refused.
3. **Switch the adapters on.** Set `MI_ADAPTERS` to the list below (or `*` for everything catalogued), then redeploy. Start with the
   ones that are already healthy and add the rest in groups, watching `lagBlocks` in `/api/v1/status` after each group:

   ```
   MI_ADAPTERS=uniswap-v2-ethereum,uniswap-v2-base,pancakeswap-v2-bnb,pancakeswap-v2-ethereum,pancakeswap-v2-base,sushiswap-v2-ethereum,sushiswap-v2-polygon,sushiswap-v2-base,uniswap-v3-ethereum,uniswap-v3-polygon,uniswap-v3-base,uniswap-v3-bnb,uniswap-v3-robinhood,pancakeswap-v3-bnb,pancakeswap-v3-ethereum,pancakeswap-v3-base,raydium-cpmm-solana,orca-whirlpool-solana,pumpswap-solana
   ```

   (`/api/v1/status` lists the exact ids; `apeswap-v2-*` are address-verified only and can be added too.)
4. **Follow list.** Each adapter follows `MI_FOLLOW_NEWEST` newest-created and `MI_FOLLOW_RECENT` most-recently-traded pools (default 100 each).
   To cover what the Markets lists show, raise both (the maximum is 2,000) once the nodes are paid; the cost scales with the number of
   pools followed (see "Provider cost" in `market-indexer.md`).
5. **Check.** `GET /api/v1/status`: every adapter you switched on should read `ok` with a small `lagBlocks`. A `failing` adapter now shows
   its reason in `lastError`.

## The two failing adapters, as found on 2026-10-31

- **PancakeSwap V2 (BNB Chain)** was 1,250,406 blocks behind (about six days): the free BNB node cannot serve a day's logs in the 45
  seconds a run is allowed. This is a node problem, not a decoder problem (its decoders are verified on real logs); a paid
  `MI_RPC_BNB` closes it. Until the lag closes, its pools' charts keep using the outside source.
- **Orca Whirlpools (Solana)** reported failures with a small lag (149 slots) and a recent success. The status did not say why; with this
  release it does. Read `lastError` after the next deploy, then send it over or fix by the message.

## What is not built

- **Backfill of history for newly followed pools.** An administrator can queue a block-range backfill for an EVM adapter (admin API,
  action `backfill`), and a pool created while the indexer runs is read from its creation. But a pool that is *started to be followed
  later* has no candles before that time, and nothing queues a backfill for it automatically: that needs a decision on how far back
  (days of logs cost node calls) and is only sensible on a paid node. Until then the chart reads older candles from the outside source.
- **Solana venues listed as not built**: Meteora DAMM v2 (needs a streaming provider to find pools), Meteora DLMM and Meteora Dynamic
  Bonding Curve. Pools on them are not indexed, so they fall back to the outside source.

Nothing here makes the app independent of GeckoTerminal and DexScreener for market lists, liquidity/FDV/market-cap figures, token
discovery or logos; those still come from them.

