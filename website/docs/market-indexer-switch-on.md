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

1. **Nodes: nothing to buy to start.** The RPC Pool (`rpc-pool.md`) shares the reads among the free public nodes with manners: it spreads load, respects each node's allowance, learns what each node refuses, shares identical requests and caches answers that cannot change. On the live free nodes it was 4 to 5 times faster than one node on Ethereum and Base, and no faster on BNB Chain, whose free nodes are slow. A paid node is an optional upgrade, not a prerequisite: set `SOLANA_RPC_URL` or `MI_RPC_<CHAIN>` (Vercel, Production, Sensitive) and it is added to the pool at a higher weight with the free nodes as the fallback.
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
  seconds a run is allowed. It is a node problem, not a decoder problem (its decoders are verified on real logs). Now an adapter further
  behind than about six hours of blocks skips ahead to that point instead of chasing the gap (the run reports `skippedBlocks`), and the pool
  spreads the work over every free BNB node; a paid `MI_RPC_BNB` is still the way to follow many BNB pools without lag.
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

