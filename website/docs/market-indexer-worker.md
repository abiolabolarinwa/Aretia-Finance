# Market Indexer as a long-running worker (self-hosted server)

`server/` (see `server/README.md`) can run the indexer as a container instead of the minute-by-minute HTTP call. The HTTP route
(`GET /api/mi-run`, see [market-indexer.md](market-indexer.md)) is unchanged and keeps working for the Supabase deployment. The worker is in `src/swings/mi/worker/`.

## How it runs

- **Scheduling.** One loop per chain, so chains never wait for each other. Inside a chain the adapters take turns in slices of
  `MI_WORKER_SLICE_SECONDS` (default 40; there is no overall 45 s budget); the adapter served longest ago goes first. Each slice is the
  same `runAll` the HTTP route uses, limited to one adapter, so checkpoints, reorg handling, admin backfill jobs and retention are the same code.
  A caught-up adapter waits `MI_WORKER_IDLE_SECONDS` (15).
- **Failures.** Backoff 5 s doubling to 5 min with jitter, per task. The log has one line when a kind of failure starts
  (`rate-limited`, `timeout`, `reorg`, `database`, `node-unreachable`, `node-limit`, `other`), a summary every five minutes while it
  lasts, and one line on recovery.
- **Shutdown.** SIGTERM/SIGINT: no new slice starts, running ones finish (checkpointed and idempotent), then exit; forced after
  `MI_WORKER_GRACE_SECONDS` (75) or on a second signal. The compose file gives it 90 s.
- **Storage.** The worker uses the same PostgREST store as the site, over the private network (`SUPABASE_URL=http://caddy:8080`):
  "direct" in the sense of the same machine, not a separate database driver.
- **Start:** `docker compose --profile worker up -d --build worker` in `server/`. Keep `mi` out of `SCHEDULER_JOBS` so the HTTP run is not also called.

## Pool backfill and reserves refresher (EVM V2 and V3 on BNB Chain, Ethereum, Polygon, Base)

- `MI_BACKFILL_DAYS=N` (default 0 = off) walks each factory's creation events back N days. From the log alone it keeps pairs with a
  recognised quote token, reads their reserves in batches through Multicall3, and registers only pools whose **dollar** liquidity is at
  least `MI_BACKFILL_MIN_LIQUIDITY_USD` (default `MI_MIN_LIQUIDITY_USD`, 500). Pools quoted in a token with no known dollar price are not
  registered. Default adapters: PancakeSwap V2/V3 and Uniswap V3 on BNB Chain (`MI_BACKFILL_ADAPTERS` overrides). Progress is a checkpoint
  row `<adapter>:backfill:<N>d`; raising N starts a new walk, and a registered pool is never registered twice.
- The **reserves refresher** (on unless `MI_REFRESH=0`) re-reads the pools written longest ago, `MI_REFRESH_LIMIT` (1,500) per pass in
  batches of `MI_REFRESH_BATCH` (150), every `MI_REFRESH_EVERY_SECONDS` (60), from the pools' own on-chain reserves (V2 `getReserves`; V3 the
  pool's token balances). It updates liquidity and re-applies the listing rules. Listing pages already sort by liquidity, so this is what
  ranks thousands of pools.
- **No invented numbers.** A pool with no stored trade gets liquidity only (`reservesOnly`) plus a price read from its reserves (V2) or its own
  current price (V3, via `slot0()`), stored as `reservePrice` / `reservePriceUsd` and shown in Markets marked with a tilde. Trade price, price change, volume and transaction
  counts are null in the API, never zero, and the pool is left out of Trending, Top and Gainers. They appear once trades are stored (the
  engine follows the newest and most recently traded pools; raise `MI_FOLLOW_*` with a dedicated node).
- **Inactive rule.** A pool that has never traded is "active" only until `MI_INACTIVE_AFTER_HOURS` (168) after its creation; set it to
  at least `MI_BACKFILL_DAYS` x 24 when you backfill.
- **Dollar liquidity** exists only for dollar-stablecoin quotes and for the wrapped/native coin when the chain's reference price is readable.
- **Not covered:** Uniswap V4, Aerodrome and Solana have no refresher or backfill. V3 liquidity is the doubled quote-token balance (an upper
  bound of what the pool can serve, as in the engine), not in-range depth.

## Chain-wide swap reading (`MI_SWAP_SCAN`)

By default the engine follows the swaps of a bounded set of pools by address (`MI_FOLLOW_NEWEST` + `MI_FOLLOW_RECENT` per adapter, 10 addresses
per `eth_getLogs` call on a public node). That cannot reach thousands of pools. Every V2 and V3 pool announces a swap with the same event, so
`MI_SWAP_SCAN=ethereum` (comma list of chains; empty = off) makes the V2/V3 adapters of those chains ask the node for that event across the
whole chain for each block range, and keep only the swaps of pools the adapter has registered (`src/swings/mi/swapScan.ts`). One request per
range replaces hundreds, and every registered pool gets real trades (price, change, volume, trades), stored exactly as on the by-address path.

- Other pools that emit the same event (other forks, unlisted dust pools) are dropped. What is looked up is remembered: a pool the adapter does not hold is asked about again after 10 minutes, a held one is re-read after 5.
- A node that refuses a range as too big (a result cap) is handled by halving the range (`getLogsHalving`). A node that answers a big range quietly with a partial list would lose swaps: check the log for `skipped` and the Ethereum counts after switching it on, and lower `maxRange` for the chain if needed.
- Uniswap V4 adapters are not covered (their swaps are read per pool id).
- With the scan on for a chain, `MI_FOLLOW_NEWEST` / `MI_FOLLOW_RECENT` no longer matter for its V2/V3 adapters.
- **Not yet run against a live node.** Tested with the fake chain only (`swapScan.test.ts`).

## Status

Tested with a fake chain and a fake Multicall3 (`worker/worker.test.ts`). **Not yet run against a live node or in Docker.** A first run
needs a dedicated BNB node (`MI_RPC_BNB`); the public ones will throttle a multi-day walk.
